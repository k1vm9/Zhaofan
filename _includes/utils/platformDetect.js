'use strict';
/**
 * platformDetect.js — Detects the current hosting environment.
 * Returns a platform object used by Main.js and ZAO.js to adapt behaviour
 * without any hard-coded Railway/Replit assumptions.
 *
 * Supported platforms (in detection order):
 *   railway  — Railway.app (RAILWAY_ENVIRONMENT or RAILWAY_SERVICE_NAME)
 *   replit   — Replit (REPL_ID or REPLIT_DEV_DOMAIN)
 *   render   — Render.com (RENDER or IS_PULL_REQUEST)
 *   heroku   — Heroku (DYNO)
 *   glitch   — Glitch.com (PROJECT_DOMAIN without REPL_ID)
 *   docker   — Running inside a Docker container (/.dockerenv or DOCKER_CONTAINER)
 *   vps      — Generic Linux VPS/RDP/server (NODE_ENV=production without above)
 *   local    — Everything else (developer machine)
 */

function detect() {
  const env = process.env;

  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_SERVICE_NAME || env.RAILWAY_PROJECT_ID) {
    return {
      name:        'railway',
      label:       'Railway.app',
      isCloud:     true,
      publicUrl:   env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null,
      port:        parseInt(env.PORT || '5000', 10),
    };
  }

  if (env.REPL_ID || env.REPLIT_DEV_DOMAIN || env.REPL_SLUG) {
    const devDomain = env.REPLIT_DEV_DOMAIN || (env.REPL_SLUG ? `${env.REPL_SLUG}.repl.co` : null);
    return {
      name:        'replit',
      label:       'Replit',
      isCloud:     true,
      publicUrl:   devDomain ? `https://${devDomain}` : null,
      port:        parseInt(env.PORT || '5000', 10),
    };
  }

  if (env.RENDER || env.RENDER_SERVICE_ID) {
    return {
      name:        'render',
      label:       'Render.com',
      isCloud:     true,
      publicUrl:   env.RENDER_EXTERNAL_URL || null,
      port:        parseInt(env.PORT || '10000', 10),
    };
  }

  if (env.DYNO) {
    return {
      name:        'heroku',
      label:       'Heroku',
      isCloud:     true,
      publicUrl:   env.HEROKU_APP_NAME ? `https://${env.HEROKU_APP_NAME}.herokuapp.com` : null,
      port:        parseInt(env.PORT || '5000', 10),
    };
  }

  if (env.PROJECT_DOMAIN && !env.REPL_ID) {
    return {
      name:        'glitch',
      label:       'Glitch.com',
      isCloud:     true,
      publicUrl:   `https://${env.PROJECT_DOMAIN}.glitch.me`,
      port:        parseInt(env.PORT || '3000', 10),
    };
  }

  const isDocker = (() => {
    try {
      const fs = require('fs');
      return fs.existsSync('/.dockerenv') || !!env.DOCKER_CONTAINER;
    } catch (_) { return false; }
  })();
  if (isDocker) {
    return {
      name:        'docker',
      label:       'Docker',
      isCloud:     false,
      publicUrl:   env.PUBLIC_URL || null,
      port:        parseInt(env.PORT || '5000', 10),
    };
  }

  if (env.NODE_ENV === 'production') {
    return {
      name:        'vps',
      label:       'VPS / RDP / Server',
      isCloud:     false,
      publicUrl:   env.PUBLIC_URL || null,
      port:        parseInt(env.PORT || '5000', 10),
    };
  }

  return {
    name:        'local',
    label:       'Local Development',
    isCloud:     false,
    publicUrl:   `http://localhost:${parseInt(env.PORT || '5000', 10)}`,
    port:        parseInt(env.PORT || '5000', 10),
  };
}

const platform = detect();
module.exports = platform;
module.exports.detect = detect;
