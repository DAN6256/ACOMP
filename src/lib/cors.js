/**
 * CORS for browser clients (e.g. the Flutter app running on the web).
 * `allowedOrigins` empty = allow any origin. Native mobile apps don't need CORS.
 */
export function cors(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': allowedOrigins.length === 0 ? '*' : origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        // Let browser code read the firmware metadata sent with ?output=file.
        'Access-Control-Expose-Headers':
          'Content-Disposition, X-Firmware-Format, X-Firmware-Sha256, X-Firmware-Fqbn, X-Firmware-Load-Address',
        'Access-Control-Max-Age': '600',
      });
      if (allowedOrigins.length > 0) res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}
