/** JSON 본문을 안전하게 읽는다. 파싱 실패 시 빈 객체를 돌려주되 타입은 유지한다. */
export async function readJson<T extends object>(req: { json: <U>() => Promise<U> }): Promise<Partial<T>> {
  try { return (await req.json<Partial<T>>()) ?? {}; }
  catch { return {}; }
}
