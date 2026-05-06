# Synology NAS Deployment

Deployment config for running Open Brain on a Synology NAS via Portainer.

## First-time setup

1. Install **Container Manager** on the NAS (DSM > Package Center)
2. In **Portainer > Registries**, add your Docker registry credentials if using a private image
3. Create the data directory via **DSM > File Station**: `/volume1/docker/open-brain/data`
4. In **Portainer > Stacks > Add stack**, paste the contents of `docker-compose.yml`
5. Add environment variables: `DB_PASSWORD`, `OPENROUTER_API_KEY`, `BRAIN_ACCESS_KEY`, `PUBLIC_ORIGIN`
6. Deploy the stack

The DB schema is auto-initialized by the app on startup (idempotent). Data is stored at `/volume1/docker/open-brain/data` on the NAS filesystem -- it survives container restarts, image updates, and `docker compose down`.

## HTTPS via Synology Reverse Proxy

HTTPS is required for OAuth (used by Claude web portal). DSM's built-in reverse proxy terminates TLS and forwards to the app container.

### 1. Get a Let's Encrypt certificate

- **Control Panel > Security > Certificate > Add > Get a certificate from Let's Encrypt**
- Enter your domain (e.g. `brain.yourdomain.com`)
- The domain must resolve to your NAS (DDNS -> router -> port forward) and port 80 must be open for the ACME challenge

### 2. Create the reverse proxy rule

- **Control Panel > Login Portal > Advanced > Reverse Proxy > Create**

| Field | Value |
|-------|-------|
| Reverse Proxy Name | `Open Brain` |
| **Source** Protocol | `HTTPS` |
| **Source** Hostname | your domain |
| **Source** Port | `443` |
| **Destination** Protocol | `HTTP` |
| **Destination** Hostname | `localhost` |
| **Destination** Port | `8420` |

- Under **Custom Header**, click **Create > WebSocket** (adds `Upgrade` and `Connection` headers for SSE/streaming)

### 3. Assign the certificate

- **Control Panel > Security > Certificate > Settings**
- Find the `Open Brain` entry, assign your Let's Encrypt cert

### 4. Port forwarding

Forward ports 80 (Let's Encrypt renewal) and 443 (HTTPS) on your router to the NAS.

### 5. Verify

```bash
curl https://brain.yourdomain.com/health
# {"status":"ok"}

curl https://brain.yourdomain.com/.well-known/oauth-authorization-server
# Should return JSON with https:// URLs
```

Set `PUBLIC_ORIGIN=https://brain.yourdomain.com` in Portainer. This keeps OAuth discovery stable even if DSM forwards traffic to the container over plain HTTP without `X-Forwarded-Proto`.

## Deploying changes

**One command** -- builds, pushes to Docker Hub, and redeploys on Portainer:

```bash
make deploy ENV=prod
```

This uses the Portainer REST API (no SSH required). It reads `PORTAINER_API_KEY` from `.env.prod`.

**Setup (one-time):** In Portainer, go to **My Account > Access tokens > Add access token**, then add it to `.env.prod`:

```bash
PORTAINER_API_KEY=ptr_your_token_here
```

The Makefile defaults (`PORTAINER_URL`, `PORTAINER_STACK_ID`, `PORTAINER_ENDPOINT_ID`) are configured for the current Synology setup. Override them if your Portainer setup changes.

**Manual alternative:** In Portainer, open the `open-brain` stack and click **Pull and redeploy** after running `make push ENV=prod`.
