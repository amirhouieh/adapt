# Local Memgraph runtime

This repository's local graph service is a single Memgraph container on
OrbStack. It is a runtime dependency for adapter development; this document
does not claim application integration or performance characteristics.

## Live instance

Observed on 2026-09-30:

| Setting | Value |
| --- | --- |
| Bolt URI | `bolt://127.0.0.1:7687` |
| Database | default database; leave the database selector empty |
| Authentication | none |
| TLS | disabled |
| Container | `adapt-memory-v2-memgraph` |
| Volume | `adapt-memory-v2-memgraph-data` mounted at `/var/lib/memgraph` |
| Image | `memgraph/memgraph:3.13.1` |
| Pinned manifest | `memgraph/memgraph@sha256:bd3fe13228f40881365486729c78110dde6e04f3c1f102c84720d31f38b693f8` |
| Pulled arm64 image ID | `sha256:f0b82e04001f9dc861d83506f08c90d53c0f5ec1aab8c3300ad9d3817a244bb4` |
| Host runtime | OrbStack 2.0.5, Docker 28.5.2, aarch64 |
| Restart policy | `unless-stopped` |

Only Bolt port 7687 is published, and its host binding is
`127.0.0.1:7687`. No monitoring or web port is published. The lack of
authentication and TLS is suitable only for this loopback-bound local service.

Memgraph 3.13.1 was the current stable release when this runtime was created.
The choice and exact flags are based on the official
[release notes](https://memgraph.com/docs/release-notes),
[configuration reference](https://memgraph.com/docs/database-management/configuration),
and [official image](https://hub.docker.com/r/memgraph/memgraph).

## Durability configuration

The container has these exact Memgraph arguments:

```text
--storage-mode=IN_MEMORY_TRANSACTIONAL
--storage-wal-enabled=true
--storage-wal-file-flush-every-n-tx=1
--storage-snapshot-interval-sec=300
--storage-snapshot-on-exit=true
--data-recovery-on-startup=true
--telemetry-enabled=false
--strict-flag-check=true
--log-level=WARNING
```

`IN_MEMORY_TRANSACTIONAL` uses WAL files and periodic snapshots. The image's
own `--help` output states that
`--storage-wal-file-flush-every-n-tx=1` issues an OS `fsync` after every
transaction and selects fully synchronous operation. Telemetry is explicitly
disabled. `SHOW STORAGE INFO` reported `IN_MEMORY_TRANSACTIONAL` and
`SNAPSHOT_ISOLATION` after both restart probes.

## Lifecycle

Start OrbStack before using Docker:

```sh
/opt/homebrew/bin/orb start
/opt/homebrew/bin/orb status
```

Operate only the project container:

```sh
docker start adapt-memory-v2-memgraph
docker stop --timeout 30 adapt-memory-v2-memgraph
docker restart --timeout 30 adapt-memory-v2-memgraph
docker logs --tail 100 adapt-memory-v2-memgraph
docker ps --filter name=adapt-memory-v2-memgraph
```

Check Bolt readiness from the bundled client:

```sh
printf '%s\n' 'RETURN 1 AS ready;' \
  | docker exec -i adapt-memory-v2-memgraph \
      mgconsole --host 127.0.0.1 --port 7687 --output-format csv
```

The first connection immediately after `docker restart` can race server
startup and return `Connection refused`. Callers need a bounded readiness retry
before sending application work.

The instance was initially created with the following configurable shell
values. Run this only when both the named container and volume do not already
exist.

```sh
MEMGRAPH_IMAGE='memgraph/memgraph@sha256:bd3fe13228f40881365486729c78110dde6e04f3c1f102c84720d31f38b693f8'
MEMGRAPH_CONTAINER='adapt-memory-v2-memgraph'
MEMGRAPH_VOLUME='adapt-memory-v2-memgraph-data'
MEMGRAPH_BIND_HOST='127.0.0.1'
MEMGRAPH_BOLT_PORT='7687'

docker volume create \
  --label com.adapt-memory.project=adapt-memory-v2 \
  "$MEMGRAPH_VOLUME"

docker run -d \
  --name "$MEMGRAPH_CONTAINER" \
  --label com.adapt-memory.project=adapt-memory-v2 \
  --restart unless-stopped \
  -p "$MEMGRAPH_BIND_HOST:$MEMGRAPH_BOLT_PORT:7687" \
  -v "$MEMGRAPH_VOLUME:/var/lib/memgraph" \
  "$MEMGRAPH_IMAGE" \
  --storage-mode=IN_MEMORY_TRANSACTIONAL \
  --storage-wal-enabled=true \
  --storage-wal-file-flush-every-n-tx=1 \
  --storage-snapshot-interval-sec=300 \
  --storage-snapshot-on-exit=true \
  --data-recovery-on-startup=true \
  --telemetry-enabled=false \
  --strict-flag-check=true \
  --log-level=WARNING
```

## Adapter boundary

The optional `@unbody-io/adapt/memgraph` entry exports the Memgraph graph
store. The ordinary package entry does not import the Neo4j driver.

The adapter stores learned graph entities, active relationships, correction
history, revision records, compact change/history/outbox records, and bounded
work coordination. Original text exists only in keyed pending work while that
input is unfinished. A partial commit atomically transfers only unresolved
`{id, text}` entries to a caller-identified continuation; settled text is
deleted. Entities, edges, and traversal results contain no source excerpts or
source-support records, so learned relationships remain queryable after their
input text is disposed.

`getLearningContext` returns bounded same-type identity candidates with
per-mention completeness, adjacent committed edges, request-scoped processed
input IDs, and explicit truncation. `traverse` walks committed active edges
with depth/entity/edge/serialized-character bounds and cancellation. Both
operations return revision pins and never hydrate the complete graph merely to
resolve a mention.

Graph commits use one Memgraph transaction for the graph patch, correction
history, compact records, consumed-input ownership, residual work, and revision
advance. Retry identity is a digest of a snapshotted compact commit intent;
raw pending text is not part of that durable attempt record. Schema metadata
can be revised without scanning the graph when structural rules are unchanged.
A structural revision is rejected when existing learned entities or active
edges would violate the new type, direction, endpoint, or self-relation rules.

## Verified behavior

Actual Cypher was executed through `mgconsole` against the production
container. Two separate committed markers were read back:

1. after a graceful `docker restart --timeout 30`;
2. after `docker kill --signal KILL` and container recovery.

The exact Cypher inputs, unmodified client outputs, container and image
inspection JSON, image help, runtime information, and logs are stored under
[`evals/.data/v2/memgraph-runtime/2026-09-30T19-07-38Z`](../evals/.data/v2/memgraph-runtime/2026-09-30T19-07-38Z/).

Memgraph logs warn that the OrbStack host's `vm.max_map_count` is `262144`,
below Memgraph's suggested `524288`. The verified small local workload ran and
recovered with the current value. It remains a capacity risk for larger graph
loads; no host-wide kernel setting was changed during this setup. Larger-load
validation and runtime-setting documentation are tracked in
[issue #28](https://github.com/amirhouieh/adapt/issues/28).
