# Quickstart

The shortest path from nothing to a first task. Each step links to the full page.

You need a Linux host with Docker Engine 26+ (Compose plugin), ports 80 and 443 reachable, and a DNS name for the server; and, on every member machine, Docker Engine 26+ with `curl` and `sh`.

1. **Deploy the server.** Point a DNS record at the host, then:

   ```sh
   git clone https://github.com/Theroxat/claude_orch.git
   cd claude_orch/deploy/server
   cp .env.example .env     # fill it in, see Installation
   docker compose up -d
   ```

   Details: {doc}`installation`.

2. **Create the GitHub App** and put its identifiers in `.env`: {doc}`github-app`.

3. **Sign in** at `https://<domain>` with GitHub, install the App on a repository and register it as a project on the **Projects** page.

4. **Install the agent** on your machine from the **My Server** page. It gives you a one-time command:

   ```sh
   curl -fsSL https://<domain>/install.sh | ORCH_TOKEN=<one-time-token> sh
   ```

   Answer yes to "Connect your Claude account now?" (or run `orch login` later). Details: {doc}`members`.

5. **Label an issue** with the project's pool label (default `pool`) on GitHub. It becomes a task. Run it yourself:

   ```sh
   orch list
   orch take 42
   orch attach 42
   orch done 42
   ```

   or let orch offer it to a teammate (or you) with enough budget. See {doc}`usage`.

6. **Optional: Claude Code.** Let Claude Code split work and submit tasks:

   ```sh
   claude mcp add --transport http --scope user orch https://<domain>/mcp
   ```

   Details: {doc}`mcp`.
