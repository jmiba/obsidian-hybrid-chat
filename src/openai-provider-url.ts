export function buildOpenAiCompatibleUrl(baseUrl: string, resource: "chat/completions" | "models"): URL {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Chat provider URL must use http or https");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol === "http:" && !local) {
    throw new Error("Remote chat providers must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.username || url.password) throw new Error("Credentials are not allowed in provider URLs");

  const cleanPath = url.pathname.replace(/\/+$/, "");
  const apiRoot = cleanPath.endsWith("/chat/completions")
    ? cleanPath.slice(0, -"/chat/completions".length)
    : cleanPath.endsWith("/models")
      ? cleanPath.slice(0, -"/models".length)
      : cleanPath.endsWith("/v1")
        ? cleanPath
        : `${cleanPath || ""}/v1`;
  url.pathname = `${apiRoot}/${resource}`;
  return url;
}
