export const available = () => typeof document !== 'undefined' && document.documentElement.dataset.westernOnline === 'true'
const base = course => '/api/laps/'+encodeURIComponent(course)

export async function submitLap({course,nickname,playerId,timeMs,replay}) {
  const query = new URLSearchParams({nickname,playerId,timeMs})
  const response = await fetch(base(course)+'?'+query,{method:'POST',body:replay})
  return response.json()
}
export async function topLaps(course,{limit=10}={}) {
  const response = await fetch(base(course)+'?limit='+encodeURIComponent(limit))
  if (!response.ok) throw new Error('Leaderboard unavailable')
  return response.json()
}
export async function fetchReplay(course,entryId) {
  const response = await fetch(base(course)+'/'+encodeURIComponent(entryId))
  if (!response.ok) throw new Error('Replay unavailable')
  return new Uint8Array(await response.arrayBuffer())
}
