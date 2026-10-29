{
  description = "Flux Pond: a buoyant creature in a stratified trench, and the checks that keep it honest";

  # The same revision the user's other repos pin, so the binary cache and the
  # Chromium that pins tests/golden are shared rather than drifting.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/5e867b1db0f219e0e906574cca1175f421a87834";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # jsdom, pngjs and esbuild exist nowhere in nixpkgs, so the three Node
      # libraries the checks import are fetched from npm against package-lock.json.
      # importNpmLock needs no hash: the integrity fields in the lock are the check.
      nodeModules = pkgs.importNpmLock.buildNodeModules {
        npmRoot = ./.;
        inherit (pkgs) nodejs;
      };

      # Everything the checks need on the environment. The app itself needs a
      # browser and nothing else; `python3 serve.py` is stdlib only.
      checkEnv = {
        # browser-check.mjs resolves Playwright from this absolute path, because
        # ESM ignores NODE_PATH.
        PLAYWRIGHT_ENTRY = "${pkgs.playwright}/index.js";
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        # importNpmLock's output root holds `node_modules` itself, and it links
        # the platform binary esbuild's JS API spawns, so nothing downloads at
        # build time and esbuild's own version stays self-consistent. (Pointing
        # ESBUILD_BINARY_PATH at nixpkgs' esbuild instead breaks: the JS API and
        # the binary speak a versioned protocol, and 0.27.7 versus 0.27.2 is
        # "The service was stopped".)
        NODE_PATH = "${nodeModules}/node_modules";
      };

      # Syntax, then the four test files that need no browser: the physics, the
      # recording render context, the stubbed audio graph, and the jsdom boot of
      # index.html. That last one rebuilds flux-pond.html and compares bytes, so
      # a stale single file fails here rather than in a preview pane.
      tests = pkgs.runCommand "flux-pond-tests"
        {
          nativeBuildInputs = [ pkgs.nodejs ];
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./src
              ./tests
              ./tools
              ./index.html
              ./flux-pond.html
              # A test walks the images the README links and decodes each one, so
              # the README and the pictures it points at are part of what the
              # checks cover, not prose beside the code.
              ./README.md
              ./docs
            ];
          };
        }
        ''
          set -euo pipefail
          # check.sh skips a layer whose library is missing rather than failing,
          # which is right on a laptop and a silent green in a build where the
          # libraries are pinned by package-lock.json. Here a skip is a broken
          # shell. $src is read-only, so the log goes in the build directory.
          checkLog=$PWD/check.log
          cd $src
          status=0
          NODE_PATH="${nodeModules}/node_modules" bash tools/check.sh > "$checkLog" 2>&1 || status=$?
          cat "$checkLog"
          if [ $status -ne 0 ]; then
            echo "flux-pond: tools/check.sh exited $status" >&2
            exit $status
          fi
          if grep -q SKIP "$checkLog"; then
            echo "flux-pond: a test layer skipped, so NODE_PATH is not serving jsdom, pngjs and esbuild" >&2
            exit 1
          fi
          touch $out
        '';
    in
    {
      packages.${system}.default = tests;

      checks.${system}.default = tests;

      # The browser layer is deliberately not a `checks` entry: it needs
      # --no-sandbox, a writable .tmp for the frames it paints, and 60 s of
      # wall-clock simulation, which no sandboxed build should be asked to
      # guarantee. `nix flake check` is the browser-free half; the workflow runs
      # the browser half through this shell.
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs
          pkgs.ffmpeg
          pkgs.git
          pkgs.python3
        ];
        env = checkEnv;
        shellHook = ''
          echo "Flux Pond: bash tools/check.sh --browser   (or: nix flake check)"
        '';
      };
    };
}
