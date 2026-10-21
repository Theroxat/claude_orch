# orch

Spread Claude Code development tasks across a small, trusted team. Each member runs tasks on their own
machine with their own Claude subscription. See [docs/PLAN.md](docs/PLAN.md).

Status: early scaffolding (milestone M1).

## Development

Everything runs in Docker. The only host requirements are `docker` with the Compose plugin and `sh`.

```sh
./dev install     # pnpm install inside the tools container
./dev lint
./dev typecheck
./dev test
./dev up          # web on http://localhost:8470, API on http://localhost:8471
./dev down
```

## License

MIT
