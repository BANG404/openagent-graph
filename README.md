# OpenAgent Graph

The standard Agent Plugin package for OpenAgent Graph Mode. The package
declares the graph capability surface, checkpoint message policies, and GitHub
subscription source. The trusted OpenAgent Runtime owns graph persistence,
parallel node scheduling, and `/graph` execution.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent.runtime` binding.

## Development

```bash
bun scripts/validate-plugin.mjs .
```

## License

MIT
