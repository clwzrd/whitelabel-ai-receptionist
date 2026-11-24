/** Configuration comes from the environment and nowhere else. */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}
