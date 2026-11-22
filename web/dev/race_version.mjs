import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
const hash=createHash('sha256')
for (const name of ['drive-sim.mjs','race/math.mjs','race/zones.mjs','race/input.mjs','race/context.mjs','race/courses.mjs','race/replay.mjs','drive-route.json']) hash.update(await readFile(new URL('../'+name,import.meta.url)))
const contents='export const SIM_VERSION = 0x'+hash.digest('hex').slice(0,8)+'\n'
const file=new URL('../race/version.mjs',import.meta.url)
if (process.argv.includes('--write')) await writeFile(file,contents)
else if (await readFile(file,'utf8')!==contents) throw new Error('Refresh race version with node web/dev/race_version.mjs --write')
