export const courses = ['college', 'stadium', 'campus']
export const nicknameOK = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.'-]{0,17}$/u.test(value)
export const json = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}})

export async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('Request too large')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const parts = []
  let length = 0
  for (;;) {
    const {value, done} = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) {
      await reader.cancel()
      throw new Error('Request too large')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
