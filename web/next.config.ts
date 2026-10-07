import type { NextConfig } from 'next';
import { z } from 'zod';

const env = z.object({ API_URL: z.url().default('http://localhost:3000') }).parse(process.env);

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${env.API_URL}/:path*` }];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
