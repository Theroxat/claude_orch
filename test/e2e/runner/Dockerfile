# E2E scenario driver: docker CLI + compose plugin (to run `docker compose exec <agent> orch ...`
# and inspect task containers on the host daemon) and Node for the scenario script.
FROM docker:27-cli
RUN apk add --no-cache nodejs
ENTRYPOINT []
CMD ["node", "test/e2e/runner/scenario.mjs"]
