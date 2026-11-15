/**
 * Shareable state in the URL hash: `#calc`, or `#calc:<data>` where data is the edited files
 * as deflated, base64url JSON.
 */

const encode = async (text: string): Promise<string> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decode = async (data: string): Promise<string> => {
  const binary = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
};

export type Shared = { readonly id: string; readonly files: Readonly<Record<string, string>> };

export const readHash = async (): Promise<Shared | null> => {
  const hash = location.hash.slice(1);
  if (!hash) return null;
  const [id, data] = hash.split(":", 2) as [string, string | undefined];
  if (!data) return { id, files: {} };
  try {
    return { id, files: JSON.parse(await decode(data)) };
  } catch {
    return { id, files: {} };
  }
};

export const writeHash = async (id: string, files: Readonly<Record<string, string>>): Promise<void> => {
  const data = Object.keys(files).length > 0 ? `:${await encode(JSON.stringify(files))}` : "";
  history.replaceState(null, "", `#${id}${data}`);
};
