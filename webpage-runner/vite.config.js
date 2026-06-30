// Default Vite config used when a project ships none. Enables React fast-refresh
// + JSX, binds all interfaces (the container is on an isolated network), and
// accepts the reverse-proxy host. A project that needs custom Vite config can
// commit its own vite.config.* and the entrypoint will prefer it.
import react from '@vitejs/plugin-react';

export default {
    plugins: [react()],
    server: {
        host: true,
        port: Number(process.env.PORT) || 5173,
        strictPort: true,
        // The dev server sits behind Bee Flow's reverse proxy on an isolated
        // network; allow any Host header so proxied requests aren't rejected.
        allowedHosts: true,
        // HMR is proxied over the app's TLS endpoint; ops sets the public port.
        hmr: { clientPort: Number(process.env.HMR_CLIENT_PORT) || 443 },
    },
};
