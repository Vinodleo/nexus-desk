// Settings → Server → Recent log's download: every line the server keeps
// (two files of about half a megabyte), so the route allows this many at once.

/** The most lines one read of /api/server-log returns: more than the log holds. */
export const LOG_DOWNLOAD_LINES = 20_000;
