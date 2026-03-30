import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import png2icons from 'png2icons'

const srcIcon = resolve('src/renderer/public/logo.png')
const outIcon = resolve('build/icon.ico')

const input = readFileSync(srcIcon)
const ico = png2icons.createICO(input, png2icons.BILINEAR, 0, false)

if (!ico || ico.length === 0) {
  throw new Error('Failed to generate .ico from source PNG')
}

mkdirSync(dirname(outIcon), { recursive: true })
writeFileSync(outIcon, ico)

console.log(`Generated: ${outIcon}`)
