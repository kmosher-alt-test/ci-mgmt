import { BridgedConfig } from "./config";
import { render } from "./make";
import { bridgedProvider } from "./make-bridged-provider";
import { bridgedProviderV2 } from "./make-bridged-provider-2";

export function buildMakefile(config: BridgedConfig): string {
  switch (config.makeTemplate) {
    case "bridged":
      return render(bridgedProvider(config));
    case "bridged-v2":
      return render(bridgedProviderV2(config));
    default:
      throw new Error(`Unknown makefile template: ${config.makeTemplate}`);
  }
}

export const scripts = {
  upstream: () => `set -e

# $1 is the current make command being run.
# It is used to make the error message more actionable.
err_rebase_in_progress() {
  cat <<EOF
A rebase is already in progress. To finish the current rebase,
complete the 'git rebase' in './upstream' and then run:

    make upstream.finalize

If you want to abandon the rebase currently in progress and
execute this target anyway, run:

    rm rebase-in-progress && make $1

EOF
  exit 1
}

assert_upstream() {
  if [ ! -d upstream ]; then
    echo "No upstream directory detected. $1 does not make sense in this context."
    exit 1
  fi
}

rebase_in_progress() {
  [ -f rebase-in-progress ]
  return $?
}

# $1 is the current make command being run.
# It is used to make the error message more actionable.
assert_no_rebase_in_progress() {
  if rebase_in_progress; then
     err_rebase_in_progress $1
  fi
}

message_rebase_clean() {
  cat <<EOF

The full patch set has been cleanly applied to the './upstream' repository.
To "edit" the patch set, commit changes directly to './upstream'. When
you are done making changes, run:

    make upstream.finalize

to finish the rebase and commit those changes into the patch set.

EOF
}

message_rebase_dirty() {
cat <<EOF

The patch set did not apply cleanly. You need to manually resolve
rebase conflicts directly in './upstream'. When you have completed
the rebase, run

    make upstream.finalize

This will finalize the changes you made back into the patch set.

EOF
}

# $1 is the current make command being run.
# It is used to make the error message more actionable.
start_rebase() {
  assert_upstream
  assert_no_rebase_in_progress $1

  git submodule update --force --init
  rm -rf .git/modules/upstream/rebase-merge
  cd upstream && git fetch

  if [ -z "$TO" ]; then
     echo '$TO not set, assuming TO is the upstream SHAH currently committed.'
  else
     git checkout "$TO"
  fi

  git checkout -B pulumi-patch \${FROM}
  git branch --set-upstream-to=local pulumi-patch

  for patch in ../patches/*.patch; do
    echo "Applying $patch"
    if ! git apply --3way $patch; then
      echo
      echo "Failed to apply patch. Please run 'make upstream.rebase FROM=$TAG' where '$TAG' allows the patch set to apply cleanly"
      echo
      exit 1
    fi
    patch=\${patch#../patches/*-}
    git commit -am "\${patch%.patch}"
  done

  touch ../rebase-in-progress

  if git rebase local; then
    message_rebase_clean
  else
    message_rebase_dirty
  fi
}

# $1 is the current make command being run.
# It is used to make the error message more actionable.
assert_rebase_in_progress() {
  if ! rebase_in_progress; then
    cat <<EOF
Didn't detect an upstream rebase in progress.
To start an upstream rebase, run

    [FROM=vX.Y.Z] [TO=vA.B.C] make upstream.rebase

If you are absolutly sure you are already in a rebase, run

    touch rebase-in-progress && make $1

EOF
    exit 1
  fi
}

# $1 is the current make command being run.
# It is used to make the error message more actionable.
apply() {
  assert_upstream
  assert_no_rebase_in_progress $1

  git submodule update --force --init
  # Iterating over the patches folder in sorted order,
  # apply the patch using a 3-way merge strategy. This mirrors the default behavior of 'git merge'
  cd upstream
  for patch in ../patches/*.patch; do
    if ! git apply --3way $patch; then
      cat <<EOF

make $1' failed to apply a patch. This is because there is a conflict between
the checked out version of upstream and the patch set. To resolve this conflict
run:

    FROM=$(echo '$LAST_KNOWN_GOOD_COMMIT') make upstream.rebase

This will walk you through resolving the conflict and producing a patch set that
cleanly applies to the current upstream.

EOF
      exit 1
    fi
  done
}

# $1 is the current make command being run.
# It is used to make the error message more actionable.
end_rebase() {
  assert_rebase_in_progress $1

  if [ -d .git/modules/upstream/rebase-merge ]; then
    echo "rebase still in progress in './upstream'. Please resolve the rebase in"
    echo "'./upstream' and then run 'make $1' again."
    exit 1
  fi

  rm patches/*.patch
  cd upstream
  git format-patch local -o ../patches
  rm ../rebase-in-progress
}

case $2 in
  apply)
    apply $1
    ;;
  start_rebase)
    start_rebase $1
    ;;
  end_rebase)
    end_rebase $1
    ;;
  *)
    cat <<EOF
Unknown argument $2.

Expected convention ./scripts/upstream.sh $@ [apply|start_rebase|end_rebase]
EOF
    ;;
esac
`,
};

export const configFile = {
	upgradeProvider: (upstreamProviderName: string) => `---
upstream-provider-name: ${upstreamProviderName}
pulumi-infer-version: true

`
}
