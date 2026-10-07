import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const config = loadConfig(process.env);
const { db } = createDb(config);

serve({ fetch: createApp({ db }).fetch, port: config.PORT }, (info) => {
  console.log(`listening on http://localhost:${info.port}`);
});
