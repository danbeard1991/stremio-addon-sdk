#!/usr/bin/env node

const WsClient = require('ws-reconnect')
const { detectFromURL, stringifyRequest } = require('stremio-addon-client')
const assert = require('assert')
const ipfsClient = require('ipfs-http-client')
const PQueue = require('p-queue').default
const throttle = require('lodash.throttle')
const crypto = require('crypto')
const HDKey = require('hdkey')
const bip39 = require('bip39')
const mkdirp = require('mkdirp')
const os = require('os')
const path = require('path')
const fs = require('fs')
const chalk = require('chalk')
const yargs = require('yargs')

const CACHING_ROUNDING = 10 * 60 * 1000
const SCRAPE_CONCURRENCY = 10
const { IPFS_WRITE_OPTS } = require('../src/p2p/consts')

const ipfs = ipfsClient(process.env.IPFS_MULTIADDR || '/ip4/127.0.0.1/tcp/5001')

const { argv } = yargs
	.usage('Usage $0 [options]')
	.describe('supernode', 'Address of the supernode')
	.default('supernode', 'ws://127.0.0.1:14011')
	.describe('restoreFromSeed', 'Restore publishing identity from BIP39 seed')
	.command('$0 <addonUrl>', 'publish the addon at the provided transport URL')

const cfgDir = path.join(os.homedir(), '.config/stremio-addon-sdk')
const keyFile = path.join(cfgDir, 'publishKey')
mkdirp.sync(cfgDir)

let seed
if (fs.existsSync(keyFile)) {
	seed = fs.readFileSync(keyFile)
} else {
	const mnemonic = bip39.generateMnemonic()
	console.log(mnemonic)
	seed = bip39.mnemonicToSeedSync(mnemonic)
	fs.writeFileSync(keyFile, seed)
}

const hdkey = HDKey.fromMasterSeed(seed)


// Shim the old extra notation
function getCatalogExtra(catalog) {
	if (Array.isArray(catalog.extra)) return catalog.extra
	if (Array.isArray(catalog.extraRequired) && Array.isArray(catalog.extraSupported)) {
		return catalog.extraSupported.map(name => ({
			isRequired: catalog.extraRequired.includes(name),
			name,
		}))
	}
	return []
}

// Attach caching information to each addon response
function getWithCache(addon, resource, type, id, extra) {
	return new Promise((resolve, reject) => {
		addon.get(resource, type, id, extra, (err, resp, cacheInfo) => {
			if (err) return reject(err)
			if (cacheInfo.cacheControl) {
				const maxAge = cacheInfo
					.cacheControl
					.split(',')
					.find(x => x.startsWith('max-age='))
				const maxAgeSeconds = maxAge && parseInt(maxAge.split('=')[1], 10)
				if (!isNaN(maxAgeSeconds)) {
					const staleAfterRaw = Date.now() + maxAgeSeconds*1000
					const staleAfter = maxAgeSeconds > 20 * 60 ?
						Math.ceil(staleAfterRaw / CACHING_ROUNDING) * CACHING_ROUNDING
						: staleAfterRaw
					resp = {
						staleAfter,
						// Still allow serving a stale response for 5x the time
						// Disabled this for now since the same implicit policy can be implemented in the Supernode,
						// we will reserve this header for when the addon SDK allows the addon creator to set this
						//expiredAfter: Date.now() + maxAgeSeconds*1000*5,
						...resp
					}
				}
			}
			resolve(resp)
		})
	})
}

function getSignedMsg(msg) {
	const hash = crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
	const sig = hdkey.sign(hash).toString('hex')
	const xpub = hdkey.publicExtendedKey
	return { msg, sig, xpub }
}


async function publish(identifier, ws) {
	const { hash } = await ipfs.files.stat(`/${identifier}`)
	const msg = { type: 'Publish', identifier, hash }
	ws.send(JSON.stringify(getSignedMsg(msg)))
}

async function scrapeItem(addon, req, queue, publish) {
	const get = getWithCache.bind(null, addon)
	const identifier = addon.manifest.id
	const resp = await get.apply(null, req)

	// Scrape other things that can be derived from this response
	if (queue && Array.isArray(resp.metas)) {
		resp.metas
			.filter(meta => addon.isSupported('meta', meta.type, meta.id))
			.forEach(meta => queue.add(scrapeItem.bind(null, addon, ['meta', meta.type, meta.id], queue, publish)))
	}
	// @NOTE: later on, we can implement streams scraping
	//if (queue && resp.meta) {
	//}

	await ipfs.files.write(
		`/${identifier}${stringifyRequest(req)}`,
		Buffer.from(JSON.stringify(resp)),
		IPFS_WRITE_OPTS
	)
	publish()

	return resp
}

async function startScrape(addon, publish) {
	const queue = new PQueue({ concurrency: SCRAPE_CONCURRENCY })
	const initialRequests = addon.manifest.catalogs
		// Check which catalogs can be requested without any extra information
		.filter(cat => {
			const required = getCatalogExtra(cat).filter(x => x.isRequired)
			return required.every(x => Array.isArray(x.options) && x.options[0])
		})
		.map(cat => {
			const required = getCatalogExtra(cat).filter(x => x.isRequired)
			return required.length ?
				['catalog', cat.type, cat.id, Object.fromEntries(required.map(x => [x.name, x.options[0]]))]
				: ['catalog', cat.type, cat.id]
		})
	initialRequests.forEach(req => queue.add(scrapeItem.bind(null, addon, req, queue, publish)))
}

async function connectToSupernode(url) {
	return new Promise((resolve, reject) => {
		const ws = new WsClient(url)
		const wsStatus = {}
		ws.onError = err => wsStatus.lastErr = err
		ws.on('connect', () => resolve(ws))
		ws.on('destroyed', () => reject(wsStatus.lastErr))
		ws.start()
	})
}

// Publish in the beginning (put up manifest + Publish msg)
// After that, we publish every time we have new content by capturing
// throttledPublish into the Request handler
async function init() {
	const detected = await detectFromURL(argv.addonUrl)
	assert.ok(detected.addon, 'unable to find an addon at this URL')

	console.log(chalk.blue('Authenticated with:'), hdkey.publicExtendedKey)
	console.log(chalk.blue('Publishing addon:'), argv.addonUrl)
	console.log(chalk.blue('Publishing to:'), argv.supernode)

	const addon = detected.addon
	const manifest = addon.manifest
	const identifier = manifest.id
	const ws = await connectToSupernode(argv.supernode)
	await ipfs.files.write(`/${identifier}/manifest.json`, Buffer.from(JSON.stringify(manifest)), IPFS_WRITE_OPTS)
	await publish(identifier, ws)
	const throttledPublish = throttle(publish.bind(null, identifier, ws), 10000)
	ws.on('message', async incoming => {
		try {
			const { msg } = JSON.parse(incoming)
			if (msg.type === 'Request') {
				const url = stringifyRequest(msg.parsed)
				// @NOTE: we can speed this up by not waiting ipfs.files.write
				const resp = await scrapeItem(addon, msg.parsed, null, throttledPublish)
				ws.send(JSON.stringify(getSignedMsg({ type: 'Response', url, resp, identifier })))
			}
		} catch (e) {
			console.error(e)
		}
	})
	startScrape(addon, throttledPublish).catch(console.error)
}

init().catch(err => console.error('Publish error', err))

