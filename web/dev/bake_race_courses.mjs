import {readFile,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {engines,serve} from './race_browser.mjs'

const options={args:process.platform==='darwin'?['--use-angle=metal']:[]}
let browser
try {browser=await engines.chromium.launch(options)} catch(error) {
  if (!error.message.includes("Executable doesn't exist")) throw error
  execFileSync(process.execPath,[fileURLToPath(new URL('../../node_modules/playwright/cli.js',import.meta.url)),'install','chromium'],{stdio:'inherit'})
  browser=await engines.chromium.launch(options)
}
const server=await serve()
try {
  const page = await browser.newPage()
  await page.goto(server.base+'/?mode=drive&course=college&diagnostics')
  await page.waitForFunction(() => window.driveMetrics?.network, null, {timeout:60000})
  const courses = await page.evaluate(() => {
    const {network} = window.driveMetrics
    return Object.fromEntries(network.circuits.map(({id,samples}) => {
      const tiles = new Map()
      for (const p of samples) {
        const cx = Math.floor(p.x/8), cz = Math.floor(p.z/8)
        for (let z = cz-2; z<=cz+2; z++) for (let x = cx-2; x<=cx+2; x++) {
          const key = x+','+z
          if (!tiles.has(key)) tiles.set(key,[])
          tiles.get(key).push(p)
        }
      }
      const cells = new Uint8Array(tiles.size*64*5)
      const view = new DataView(cells.buffer)
      let offset = 0
      for (const [key,points] of tiles) {
        const [cx,cz] = key.split(',').map(Number)
        for (let j=0;j<8;j++) for (let i=0;i<8;i++) {
          const x=cx*8+i,z=cz*8+j
          let nearest, best=Infinity
          for (const point of points) {
            const d=(point.x-x)**2+(point.z-z)**2
            if (d<best) {best=d;nearest=point}
          }
          const sample=network.sample(x,z,nearest.y)
          view.setInt16(offset,Math.round(sample.y*100),true)
          const slope=v=>Math.min(127,Math.max(-127,Math.round(v*256)))
          view.setInt8(offset+2,slope(sample.grade*sample.tangentX))
          view.setInt8(offset+3,slope(sample.grade*sample.tangentZ))
          cells[offset+4]=['grass','path','road'].indexOf(sample.surface) | (network.blocked(x,z,sample.y,.9)?4:0)
          offset+=5
        }
      }
      const parts=[]
      for (let i=0;i<cells.length;i+=8192) parts.push(String.fromCharCode(...cells.subarray(i,i+8192)))
      return [id,{samples,tiles:[...tiles.keys()],cells:btoa(parts.join(''))}]
    }))
  })
  const file=new URL('../race/courses.mjs',import.meta.url)
  const generated='export default '+JSON.stringify(courses)+'\n'
  if (await readFile(file,'utf8')!==generated) {
    if (process.argv.includes('--check')) throw new Error('Race surface, height, clearance or gates differ from the live campus network. Run npm run build.')
    await writeFile(file,generated)
    console.log('Updated race course surfaces and collision from the hosted campus')
  }
  console.log(Object.entries(courses).map(([id,c])=>[id,c.samples.length,c.tiles.length]))
} finally {await browser.close();server.close()}
