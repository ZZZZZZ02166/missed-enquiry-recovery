# Project-local Node. Source this in a shell that needs to run pnpm/node here:
#
#     source .tools/env.sh
#
# Why this exists
# ---------------
# Homebrew upgraded llhttp from 9.3 to 9.4.3, and the Homebrew Node 25.8.0 binary is
# dynamically linked against libllhttp.9.3.dylib, which no longer exists. Every node,
# npx, npm and pnpm invocation dies in dyld before running a line of JavaScript:
#
#     dyld: Library not loaded: /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib
#
# Rather than touch the Homebrew installation, this repo carries its own Node under
# .tools/node. It is the version .nvmrc already pins (24), which CLAUDE.md notes is what
# production should run anyway — Node 25 is a non-LTS odd release Prisma does not test
# against. So this is not only a workaround, it moves local development onto the
# supported version.
#
# The tarball came from nodejs.org and its SHA-256 was checked against the published
# SHASUMS256.txt before extraction.
#
# Claude Code sessions get this automatically via the "env.PATH" entry in
# .claude/settings.json — this file is for your own terminal.

_MER_NODE_BIN="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)/node/bin"

case ":$PATH:" in
  *":$_MER_NODE_BIN:"*) ;;                    # already present, do not stack duplicates
  *) PATH="$_MER_NODE_BIN:$PATH"; export PATH ;;
esac

unset _MER_NODE_BIN
