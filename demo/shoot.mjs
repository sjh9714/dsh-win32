// Frame shooter. Renders movie.html frame by frame through window.seek(t).
// Env. FPS (default 30), FRAMES=a,b ms range, MOVIE=file, OUT=dir.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FPS = Number(process.env.FPS ?? 30)
const OUT = process.env.OUT ?? join(here, '_frames')
const MOVIE = process.env.MOVIE ?? join(here, 'movie.html')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-device-scale-factor=1'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(pathToFileURL(MOVIE).href, { waitUntil: 'networkidle' })
await page.evaluate(() => window.ready)
const DURATION = await page.evaluate(() => window.DURATION)

const step = 1000 / FPS
let [fromMs, toMs] = (process.env.FRAMES ?? `0,${DURATION}`).split(',').map(Number)
const first = Math.floor(fromMs / step)
const last = Math.ceil(toMs / step)
for (let i = first; i <= last; i++) {
  await page.evaluate((t) => window.seek(t), Math.min(i * step, DURATION))
  await page.screenshot({ path: join(OUT, `frame_${String(i).padStart(5, '0')}.png`) })
}
console.log(`rendered frames ${first}..${last} at ${FPS}fps into ${OUT}`)
await browser.close()
