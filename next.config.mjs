/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer, webpack }) => {
    // mupdf / harfbuzz / pdf.js contain Node-only branches (node:fs, fs, path, canvas).
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      }),
    );
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      crypto: false,
      module: false,
      url: false,
      worker_threads: false,
    };
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false };
    config.experiments = { ...(config.experiments || {}), asyncWebAssembly: true, topLevelAwait: true };
    config.output.environment = { ...(config.output.environment || {}), asyncFunction: true, module: true, dynamicImport: true };
    if (!isServer) config.output.globalObject = 'self';
    return config;
  },
  async headers() {
    return [
      {
        source: '/(fonts|wasm|tesseract|pdfjs)/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
