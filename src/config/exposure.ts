// Anything that only makes sense on a developer's own machine — demo OTP codes in
// responses, stack traces in errors — stays off as soon as a proxy or tunnel is
// configured, because the server is then reachable from outside.
export function localOnlyFlags(e: { NODE_ENV: string; DEMO_EXPOSE_OTP: boolean; TRUSTED_PROXY_COUNT: number }) {
    const isLocalOnly = e.NODE_ENV === 'development' && e.TRUSTED_PROXY_COUNT === 0;
    return { isLocalOnly, exposeDemoOtp: e.DEMO_EXPOSE_OTP && isLocalOnly };
}
