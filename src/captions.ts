// Shared by the background (which notes caption requests per tab) and the host (which waits for one).

/** A caption file, by URL or content type: WebVTT, SRT, TTML/DFXP, or YouTube's timedtext. */
export function isCaptionRequest(url: string, contentType = ''): boolean {
  if (/^(text\/vtt|application\/x-subrip|text\/srt|application\/ttml\+xml|application\/ttaf\+xml)/i.test(contentType)) return true;
  try {
    const u = new URL(url);
    if (u.pathname === '/api/timedtext') return true;
    if (/\.(vtt|webvtt|srt|ttml|dfxp)$/i.test(u.pathname)) return true;
    return /^(vtt|webvtt|srt|ttml|dfxp)$/i.test(u.searchParams.get('format') ?? u.searchParams.get('fmt') ?? '');
  } catch {
    return false;
  }
}
