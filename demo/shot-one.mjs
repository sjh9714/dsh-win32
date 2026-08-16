// One-shot page screenshot. Env. PAGE (html file), OUT (png), W, H.
import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PAGE = process.env.PAGE ?? join(here, 'market-card.html')
const OUT = process.env.OUT ?? join(here, '..', 'assets', 'market-card.png')
const W = Number(process.env.W ?? 1200)
const H = Number(process.env.H ?? 800)

const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-device-scale-factor=1'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'networkidle' })
await page.screenshot({ path: OUT })
await browser.close()
console.log(`shot ${PAGE} -> ${OUT} (${W}x${H})`)
