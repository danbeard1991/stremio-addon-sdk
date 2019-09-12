const WebSocket = require('ws')
const ipfsClient = require('ipfs-http-client')
const HDKey = require('hdkey')
const crypto = require('crypto')

const { IPFS_WRITE_OPTS, IPFS_MSG_PATH } = require('./p2p')

const byIdentifier = new Map()

function onConnection(ws) {
	// @TODO associate the connection with an addon and don't allow other connections to claim the same
	// one
	ws.on('message', data => {
		try {
			const { xpub, sig, msg } = JSON.parse(data)
			const hdkey = HDKey.fromExtendedKey(xpub)
			const hash = crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
			if (!hdkey.verify(hash, Buffer.from(sig, 'hex'))) {
				throw new Error('invalid signature')
			}
			// @TODO more checks
			if (msg) onMessage(xpub, msg).catch(e => console.error(e))
		} catch(e) {
			// catches the parse
			// @TODO better way to do this
			console.error(e)
		}
	})
	//ws.send(JSON.stringify());
}

// @TODO pin
async function onMessage(xpub, msg) {
	if (msg.type === 'Publish') {
		const identifier = `${xpub.slice(4, 16)}.${msg.identifier}`
		//console.log(identifier)
		byIdentifier.set(identifier, msg.hash)
		await ipfs.files.write(`${IPFS_MSG_PATH}/${identifier}`, Buffer.from(JSON.stringify(msg)), IPFS_WRITE_OPTS)
	}
}

async function readCachedMsgs() {
	const files = await ipfs.files.ls(`/${IPFS_MSG_PATH}`)
	// @TODO: warning: this doesn't consider whether the contents are files or not
	const buffers = await Promise.all(files.map(f => ipfs.files.read(`/${IPFS_MSG_PATH}/${f.name}`)))
	for (let buf of buffers) {
		// @TODO: reuse onMessage, but without the write
		const msg = JSON.parse(buf.toString())
		byIdentifier.set(msg.identifier, msg.hash)
	}
}

// Server part
// @TODO handle caching information
const express = require('express')
const app = express()
const ipfs = ipfsClient('localhost', '5001', { protocol: 'http' })
app.use('/:identifier', async function(req, res) {
	const hash = byIdentifier.get(req.params.identifier.trim())
	if (hash) {
		const path = `/ipfs/${hash}${req.url}`
		res.setHeader('content-type', 'application/json')
		ipfs.catReadableStream(path)
			.on('error', e => {
				if (e.statusCode === 500 && e.message.startsWith('no link named'))
					res.status(404).json({ error: 'Not found' })
				else
					throw e
			})
			.pipe(res)
	} else {
		res.sendStatus(404)
	}
})

// Initialize
async function init() {
	// replay previous Publish messages
	await readCachedMsgs()

	const wss = new WebSocket.Server({ port: 14001 })
	wss.on('connection', onConnection)

	app.listen(3006)
}

init().catch(e => console.error(e))
