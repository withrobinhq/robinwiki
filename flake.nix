{
  description = "Robin dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      mkDevShell = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # PostgreSQL bundled with pgvector (Robin runs `CREATE EXTENSION vector`).
          postgres = pkgs.postgresql_16.withPackages (ps: [ ps.pgvector ]);

          # Shared shell fragment: path variables + portable port helpers.
          # Sourced by every script so they can't drift from each other.
          commonPreamble = ''
            ROBIN_DEV_DIR="''${ROBIN_DEV_DIR:-.dev}"
            PROJECT_ROOT="''${PROJECT_ROOT:-$PWD}"

            # Postgres port, defaults to 5432. Override with PG_PORT when the
            # system already has something on 5432 (Postgres.app, Homebrew, Docker, etc.).
            # PGPORT is libpq's standard env var; we mirror PG_PORT into it so
            # psql, createdb, and pg_isready inherit the same value without
            # any further wiring.
            PG_PORT="''${PG_PORT:-5432}"
            export PGPORT="$PG_PORT"

            PG_DATA="$ROBIN_DEV_DIR/postgres/data"
            PG_SOCKET="$ROBIN_DEV_DIR/postgres/socket"
            PG_LOG="$ROBIN_DEV_DIR/postgres/postgres.log"
            PG_PID="$ROBIN_DEV_DIR/postgres/postgres.pid"

            REDIS_DATA="$ROBIN_DEV_DIR/redis/data"
            REDIS_LOG="$ROBIN_DEV_DIR/redis/redis.log"
            REDIS_PID="$ROBIN_DEV_DIR/redis/redis.pid"

            CORE_PID="$ROBIN_DEV_DIR/core/core.pid"
            CORE_LOG="$ROBIN_DEV_DIR/core/core.log"

            WIKI_PID="$ROBIN_DEV_DIR/wiki/wiki.pid"
            WIKI_LOG="$ROBIN_DEV_DIR/wiki/wiki.log"

            # lsof-based port probes — portable across Linux and macOS.
            port_holder_pid() {
              ${pkgs.lsof}/bin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
            }

            port_is_bound() {
              [ -n "$(${pkgs.lsof}/bin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ]
            }

            port_pids() {
              ${pkgs.lsof}/bin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
            }

            # Fail loud if a port is already held by a foreign process.
            preflight_port() {
              local label=$1 port=$2
              local holder
              holder=$(port_holder_pid "$port")
              [ -z "$holder" ] && return 0
              local holder_cmd
              holder_cmd=$(ps -p "$holder" -o command= 2>/dev/null || echo unknown)
              echo "ERROR: $label port :$port already held by pid $holder"
              echo "  $holder_cmd"
              echo "  free the port first (or 'kill $holder') and re-run"
              return 1
            }

            # Verify a spawned service: tracked pid stays alive AND port binds.
            verify_spawn() {
              local label=$1 pidfile=$2 port=$3 logfile=$4 max=''${5:-15}
              local pid
              pid=$(cat "$pidfile" 2>/dev/null || echo "")
              if [ -z "$pid" ]; then
                echo "ERROR: $label did not write a pid file"
                [ -f "$logfile" ] && tail -20 "$logfile" | sed "s#^#  $label log: #"
                return 1
              fi
              local i
              for i in $(seq 1 "$max"); do
                if ! kill -0 "$pid" 2>/dev/null; then
                  echo "ERROR: $label process $pid exited before binding :$port"
                  [ -f "$logfile" ] && tail -20 "$logfile" | sed "s#^#  $label log: #"
                  rm -f "$pidfile"
                  return 1
                fi
                if port_is_bound "$port"; then
                  return 0
                fi
                sleep 1
              done
              echo "ERROR: $label did not bind :$port within ''${max}s"
              [ -f "$logfile" ] && tail -20 "$logfile" | sed "s#^#  $label log: #"
              kill "$pid" 2>/dev/null || true
              rm -f "$pidfile"
              return 1
            }

            # Retry a health URL until 2xx or timeout. On failure: tail log, exit 1.
            wait_healthy() {
              local label=$1 url=$2 logfile=$3 max=''${4:-30}
              local i
              for i in $(seq 1 "$max"); do
                if ${pkgs.curl}/bin/curl -sf "$url" >/dev/null 2>&1; then
                  return 0
                fi
                sleep 1
              done
              echo "ERROR: $label did not return 2xx from $url within ''${max}s"
              [ -f "$logfile" ] && tail -20 "$logfile" | sed "s#^#  $label log: #"
              return 1
            }

            # Shared stop helper: graceful kill by port, then SIGKILL if needed.
            stop_port() {
              local label=$1 port=$2 pidfile=$3
              local pids
              pids=$(port_pids "$port") || true
              if [ -n "$pids" ]; then
                echo "$label stopping..."
                echo "$pids" | xargs kill 2>/dev/null || true
                for i in $(seq 1 15); do
                  pids=$(port_pids "$port") || true
                  [ -z "$pids" ] && break
                  sleep 0.2
                done
                pids=$(port_pids "$port") || true
                if [ -n "$pids" ]; then
                  echo "$pids" | xargs kill -9 2>/dev/null || true
                fi
                echo "$label stopped"
              fi
              rm -f "$pidfile"
            }
          '';

          # --- Dev service management scripts ---

          # `init` — boot postgres + redis. Idempotent.
          initScript = pkgs.writeShellScriptBin "init" ''
            set -euo pipefail
            ${commonPreamble}

            mkdir -p "$PG_DATA" "$PG_SOCKET" "$REDIS_DATA"

            # ── PostgreSQL ──────────────────────────────────────────
            if [ -f "$PG_PID" ] && kill -0 "$(cat "$PG_PID")" 2>/dev/null; then
              echo "postgres: already running (pid $(cat "$PG_PID"))"
            else
              rm -f "$PG_PID"
              preflight_port "postgres" "$PG_PORT"

              if [ ! -f "$PG_DATA/PG_VERSION" ]; then
                echo "postgres: initializing data directory..."
                ${postgres}/bin/initdb \
                  --pgdata="$PG_DATA" \
                  --username=postgres \
                  --auth=trust \
                  --no-locale \
                  --encoding=UTF8 \
                  > /dev/null

                cat >> "$PG_DATA/postgresql.conf" <<-PGCONF
				listen_addresses = '127.0.0.1'
				port = $PG_PORT
				unix_socket_directories = '$PG_SOCKET'
				log_destination = 'stderr'
				logging_collector = off
				PGCONF
              fi

              echo "postgres: starting..."
              ${postgres}/bin/pg_ctl start \
                -D "$PG_DATA" \
                -l "$PG_LOG" \
                -w \
                -o "-k $PG_SOCKET -p $PG_PORT"

              head -1 "$PG_DATA/postmaster.pid" > "$PG_PID"
              verify_spawn "postgres" "$PG_PID" "$PG_PORT" "$PG_LOG" 5

              if ! ${postgres}/bin/psql -h 127.0.0.1 -U postgres -lqt 2>/dev/null | grep -qw robinwiki; then
                echo "postgres: creating database robinwiki..."
                ${postgres}/bin/createdb -h 127.0.0.1 -U postgres robinwiki
              fi

              echo "postgres: ready (pid $(cat "$PG_PID"))"
            fi

            # ── Redis ───────────────────────────────────────────────
            # Redis conflicts are tolerated — if someone else owns :6379, we just reuse it.
            if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
              echo "redis:    already running (pid $(cat "$REDIS_PID"))"
            elif ${pkgs.redis}/bin/redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
              echo "redis:    already responding on :6379 (external, reusing)"
              rm -f "$REDIS_PID"
            else
              rm -f "$REDIS_PID"
              echo "redis:    starting..."
              ${pkgs.redis}/bin/redis-server \
                --daemonize yes \
                --pidfile "$(realpath "$REDIS_PID" 2>/dev/null || echo "$PWD/$REDIS_PID")" \
                --dir "$REDIS_DATA" \
                --logfile "$(realpath "$REDIS_LOG" 2>/dev/null || echo "$PWD/$REDIS_LOG")" \
                --appendonly yes \
                --save "" \
                --bind 127.0.0.1 \
                --port 6379

              for i in 1 2 3 4 5; do
                [ -f "$REDIS_PID" ] && break
                sleep 0.2
              done

              if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
                echo "redis:    ready (pid $(cat "$REDIS_PID"))"
              else
                echo "redis:    spawn failed (best-effort; continuing)"
                rm -f "$REDIS_PID"
              fi
            fi

            echo ""
            echo "  infra ready — run 'start' to launch core + wiki"
            echo ""
          '';

          # `start` — boot core + wiki. Requires infra to be up (init first).
          startScript = pkgs.writeShellScriptBin "start" ''
            set -euo pipefail
            ${commonPreamble}

            mkdir -p "$ROBIN_DEV_DIR/core" "$ROBIN_DEV_DIR/wiki"

            # ── Preflight: infra must be up ────────────────────────
            if ! ${postgres}/bin/pg_isready -h 127.0.0.1 -p "$PG_PORT" -U postgres -q 2>/dev/null; then
              echo "ERROR: postgres is not accepting connections on :$PG_PORT"
              echo "  run 'init' first to bring up postgres + redis"
              exit 1
            fi
            if ! ${pkgs.redis}/bin/redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
              echo "ERROR: redis is not responding on :6379"
              echo "  run 'init' first to bring up postgres + redis"
              exit 1
            fi

            # ── Workspace packages ─────────────────────────────────
            # core imports compiled @robin/queue, @robin/agent, etc. from each
            # package's dist/. Without this, first-run start fails with a cryptic
            # ERR_MODULE_NOT_FOUND on @robin/queue/dist/index.mjs. Turbo caches,
            # so subsequent runs are near-instant.
            PACKAGES_LOG="$ROBIN_DEV_DIR/packages.log"
            echo "packages: building..."
            if ! (cd "$PROJECT_ROOT" && pnpm exec turbo run build --filter='./packages/*') > "$PACKAGES_LOG" 2>&1; then
              echo "ERROR: workspace package build failed"
              tail -20 "$PACKAGES_LOG" | sed 's#^#  packages log: #'
              exit 1
            fi
            echo "packages: ready"

            # ── Core (Robin API server) ────────────────────────────
            if [ -f "$CORE_PID" ] && kill -0 "$(cat "$CORE_PID")" 2>/dev/null; then
              echo "core:     already running (pid $(cat "$CORE_PID"))"
            else
              rm -f "$CORE_PID"
              preflight_port "core" 3000

              echo "core:     starting..."
              (cd "$PROJECT_ROOT" && pnpm --filter @robin/core dev) < /dev/null >> "$CORE_LOG" 2>&1 &
              echo $! > "$CORE_PID"
              disown %+ 2>/dev/null || true
              verify_spawn "core" "$CORE_PID" 3000 "$CORE_LOG" 15
              wait_healthy "core" http://localhost:3000/health "$CORE_LOG" 15
              echo "core:     ready (pid $(cat "$CORE_PID"))"
            fi

            # ── Wiki (Next.js frontend) ────────────────────────────
            if [ -f "$WIKI_PID" ] && kill -0 "$(cat "$WIKI_PID")" 2>/dev/null; then
              echo "wiki:     already running (pid $(cat "$WIKI_PID"))"
            else
              rm -f "$WIKI_PID"
              preflight_port "wiki" 8080

              echo "wiki:     starting..."
              (cd "$PROJECT_ROOT" && PORT=8080 pnpm --filter @robin/wiki dev) < /dev/null >> "$WIKI_LOG" 2>&1 &
              echo $! > "$WIKI_PID"
              disown %+ 2>/dev/null || true
              verify_spawn "wiki" "$WIKI_PID" 8080 "$WIKI_LOG" 20
              wait_healthy "wiki" http://localhost:8080 "$WIKI_LOG" 60
              echo "wiki:     ready (pid $(cat "$WIKI_PID"))"
            fi

            echo ""
            echo "  core → http://localhost:3000"
            echo "  wiki → http://localhost:8080"
            echo ""
          '';

          # `stop` — kill the apps only. Infra keeps running.
          stopScript = pkgs.writeShellScriptBin "stop" ''
            set -euo pipefail
            ${commonPreamble}

            # Reverse order: wiki → core
            stop_port "wiki: " 8080 "$WIKI_PID"
            stop_port "core: " 3000 "$CORE_PID"
          '';

          # `teardown` — stop apps + shut down infra.
          teardownScript = pkgs.writeShellScriptBin "teardown" ''
            set -euo pipefail
            ${commonPreamble}

            # ── Apps first ──────────────────────────────────────────
            stop_port "wiki: " 8080 "$WIKI_PID"
            stop_port "core: " 3000 "$CORE_PID"

            # ── PostgreSQL ──────────────────────────────────────────
            if [ -f "$PG_PID" ] && kill -0 "$(cat "$PG_PID")" 2>/dev/null; then
              echo "postgres: stopping..."
              ${postgres}/bin/pg_ctl stop -D "$PG_DATA" -m fast
              rm -f "$PG_PID"
              echo "postgres: stopped"
            else
              echo "postgres: not running"
              rm -f "$PG_PID"
            fi

            # ── Redis ───────────────────────────────────────────────
            if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
              echo "redis:    stopping..."
              ${pkgs.redis}/bin/redis-cli -h 127.0.0.1 -p 6379 shutdown nosave 2>/dev/null || true
              rm -f "$REDIS_PID"
              echo "redis:    stopped"
            else
              echo "redis:    not running"
              rm -f "$REDIS_PID"
            fi
          '';

          statusScript = pkgs.writeShellScriptBin "status" ''
            set -euo pipefail
            ROBIN_DEV_DIR="''${ROBIN_DEV_DIR:-.dev}"

            PG_PID="$ROBIN_DEV_DIR/postgres/postgres.pid"
            REDIS_PID="$ROBIN_DEV_DIR/redis/redis.pid"
            CORE_PID="$ROBIN_DEV_DIR/core/core.pid"
            WIKI_PID="$ROBIN_DEV_DIR/wiki/wiki.pid"

            if [ -f "$PG_PID" ] && kill -0 "$(cat "$PG_PID")" 2>/dev/null; then
              if ${postgres}/bin/pg_isready -h 127.0.0.1 -p "$PG_PORT" -U postgres -q 2>/dev/null; then
                echo "postgres: UP (pid $(cat "$PG_PID"), accepting connections)"
              else
                echo "postgres: UP (pid $(cat "$PG_PID"), NOT accepting connections)"
              fi
            else
              echo "postgres: DOWN"
            fi

            if [ -f "$REDIS_PID" ] && kill -0 "$(cat "$REDIS_PID")" 2>/dev/null; then
              if ${pkgs.redis}/bin/redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
                echo "redis:    UP (pid $(cat "$REDIS_PID"), responding to PING)"
              else
                echo "redis:    UP (pid $(cat "$REDIS_PID"), NOT responding)"
              fi
            else
              echo "redis:    DOWN"
            fi

            if [ -f "$CORE_PID" ] && kill -0 "$(cat "$CORE_PID")" 2>/dev/null; then
              if ${pkgs.curl}/bin/curl -sf http://localhost:3000/health > /dev/null 2>&1; then
                echo "core:     UP (pid $(cat "$CORE_PID"), healthy)"
              else
                echo "core:     UP (pid $(cat "$CORE_PID"), NOT healthy)"
              fi
            else
              echo "core:     DOWN"
            fi

            if [ -f "$WIKI_PID" ] && kill -0 "$(cat "$WIKI_PID")" 2>/dev/null; then
              if ${pkgs.curl}/bin/curl -sf http://localhost:8080 > /dev/null 2>&1; then
                echo "wiki:     UP (pid $(cat "$WIKI_PID"), healthy)"
              else
                echo "wiki:     UP (pid $(cat "$WIKI_PID"), NOT healthy)"
              fi
            else
              echo "wiki:     DOWN"
            fi
          '';

          logsScript = pkgs.writeShellScriptBin "logs" ''
            set -euo pipefail
            ROBIN_DEV_DIR="''${ROBIN_DEV_DIR:-.dev}"

            case "''${1:-}" in
              "")
                echo "tailing all logs (ctrl-c to stop)..."
                tail -f \
                  "$ROBIN_DEV_DIR/postgres/postgres.log" \
                  "$ROBIN_DEV_DIR/redis/redis.log" \
                  "$ROBIN_DEV_DIR/core/core.log" \
                  "$ROBIN_DEV_DIR/wiki/wiki.log" \
                  2>/dev/null
                ;;
              postgres)
                tail -f "$ROBIN_DEV_DIR/postgres/postgres.log" ;;
              redis)
                tail -f "$ROBIN_DEV_DIR/redis/redis.log" ;;
              core)
                tail -f "$ROBIN_DEV_DIR/core/core.log" ;;
              wiki)
                tail -f "$ROBIN_DEV_DIR/wiki/wiki.log" ;;
              *)
                echo "usage: logs [postgres|redis|core|wiki]"
                exit 1
                ;;
            esac
          '';

        in
        pkgs.mkShell {
          name = "robin";

          packages = [
            # Runtimes
            pkgs.nodejs_22
            pkgs.pnpm_10

            # Services
            postgres
            pkgs.redis
            pkgs.caddy

            # System tools
            pkgs.git
            pkgs.openssl
            pkgs.curl
            pkgs.jq
            pkgs.lsof

            # Dev service management
            initScript
            startScript
            stopScript
            teardownScript
            statusScript
            logsScript
          ];

          shellHook = ''
            export ROBIN_DEV_DIR="$PWD/.dev"
            export PROJECT_ROOT="$PWD"

            echo ""
            echo "  robin dev shell"
            echo "  run 'init'     to boot postgres + redis"
            echo "  run 'start'    to launch core + wiki"
            echo "  run 'stop'     to kill core + wiki (infra keeps running)"
            echo "  run 'teardown' to stop everything"
            echo "  run 'status'   to check service health"
            echo "  run 'logs [service]' to tail logs"
            echo ""
          '';
        };
    in {
      devShells = forAllSystems (system: {
        default = mkDevShell system;
      });
    };
}
