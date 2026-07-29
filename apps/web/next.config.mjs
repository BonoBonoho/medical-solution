/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // 도메인 패키지는 워크스페이스 소스를 그대로 쓴다.
  transpilePackages: ['@mediwork/domain'],
};
