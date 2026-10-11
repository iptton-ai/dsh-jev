#!/usr/bin/env node
// Local development helper. Creates links only; never installs or copies DSH core packages.
import { access, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const hostModules = resolve(process.argv[2] ?? join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules'))
const peers = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials']
const links = []

try {
  for (const peer of peers) {
    const source = join(hostModules, peer)
    await access(source, constants.R_OK)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (manifest.name !== peer) throw new Error(`Unexpected package at ${source}`)
    if (peer.startsWith('@deepseek-ai/dsh-') && manifest.version !== '0.2.0-rc.2') {
      throw new Error(`${peer}@${manifest.version}: this checkout has been tested with DSH 0.2.0-rc.2; review compatibility before linking another runtime.`)
    }
    if (!isAbsolute(source)) throw new Error('Expected an absolute host package path.')
    const destination = join(root, 'node_modules', peer)
    const existing = await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing) {
      if (!existing.isSymbolicLink() || await realpath(destination) !== await realpath(source)) {
        throw new Error(`Refusing to overwrite ${destination}; it is not already linked to ${source}.`)
      }
    } else {
      links.push({ source, destination, version: manifest.version })
    }
  }
  for (const { source, destination, version } of links) {
    await mkdir(dirname(destination), { recursive: true })
    await symlink(source, destination, 'dir')
    console.log(`Linked ${destination} -> ${source} (${version})`)
  }
  if (!links.length) console.log('All host dependency links are already correct.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
