/** The promise's value, or undefined once `ms` have passed without one. */
export async function within<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeUp = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, ms, undefined)));
  try {
    return await Promise.race([promise, timeUp]);
  } finally {
    clearTimeout(timer);
  }
}
