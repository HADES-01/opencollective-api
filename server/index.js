import './env';

import os from 'os';

import config from 'config';
import express from 'express';
import throng from 'throng';

import expressLib from './lib/express';
import logger from './lib/logger';
import routes from './routes';

async function start(i) {
  const expressApp = express();

  await expressLib(expressApp);

  /**
   * Routes.
   */
  routes(expressApp);

  /**
   * Start server
   */
  const server = expressApp.listen(config.port, () => {
    const host = os.hostname();
    logger.info(
      'Open Collective API listening at http://%s:%s in %s environment. Worker #%s',
      host,
      server.address().port,
      config.env,
      i,
    );
    if (config.maildev.server) {
      const maildev = require('./maildev'); // eslint-disable-line @typescript-eslint/no-var-requires
      maildev.listen();
    }
  });

  server.timeout = 25000; // sets timeout to 25 seconds

  return expressApp;
}

let app;

if (['production', 'staging'].includes(config.env)) {
  const workers = process.env.WEB_CONCURRENCY || 1;
  throng({ workers, lifetime: Infinity }, start);
} else {
  app = start(1);
}

// This is used by tests
export default async function () {
  return app ? app : start(1);
}
