import withBundleAnalyzer from '@next/bundle-analyzer';


/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
})(config);
