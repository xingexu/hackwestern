import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {once} from 'node:events'

export * as engines from 'playwright'
export async function serve(source = false) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const child = spawn(process.execPath, ['serve.mjs','--port','0', ...(source ? ['--root','web'] : process.env.CAMPUS_RACE_PREVIEW ? ['--root',process.env.CAMPUS_RACE_PREVIEW] : [])], {cwd:root,stdio:['ignore','pipe','inherit']})
  const [startup] = await once(child.stdout,'data')
  return {base:startup.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0], close:() => child.kill()}
}
