import { BridgedConfig } from "./config";
import { Makefile, Target } from "./make";

export function bridgedProvider(config: BridgedConfig): Makefile {
  const PACK = config.provider;
  const ORG = "pulumi";
  const PROJECT = `github.com/$(ORG)/pulumi-$(PACK)`;
  const PROVIDER_PATH =
    config["major-version"] > 1
      ? `provider/v${config["major-version"]}`
      : `provider`;
  const VERSION_PATH = `$(PROVIDER_PATH)/pkg/version.Version`;
  const TFGEN = `pulumi-tfgen-$(PACK)`;
  const JAVA_GEN = `pulumi-java-gen`;
  const JAVA_GEN_VERSION = config.javaGenVersion || "v0.5.4";
  const PROVIDER = `pulumi-resource-$(PACK)`;
  const VERSION = "$(shell pulumictl get version)";
  const TESTPARALLELISM = "10";
  const WORKING_DIR = "$(shell pwd)";

  const variables = {
    PACK,
    ORG,
    PROJECT,
    PROVIDER_PATH,
    VERSION_PATH,
    TFGEN,
    PROVIDER,
    VERSION,
    JAVA_GEN,
    JAVA_GEN_VERSION,
    TESTPARALLELISM,
    WORKING_DIR,
  } as const;

  const docs: Target = {
    name: "docs",
    phony: true,
    commands: [config.docsCmd],
  };

  const install_plugins: Target = {
    name: "install_plugins",
    phony: true,
    commands: [
      '[ -x "$(shell command -v pulumi)" ] || curl -fsSL https://get.pulumi.com | sh',
      ...(config.plugins?.map(
        (p) => `pulumi plugin install resource ${p.name} ${p.version}`
      ) ?? []),
    ],
  };

  let startPatch: Target | null = null;
  let finishPatch: Target | null = null;
  let upstream: Target | null = null;
  if (config.team === "ecosystem") {
    upstream = {
      name: "upstream",
      phony: true,
      commands: [{
        parts: [
          {
            test: `ifeq ("$(wildcard upstream)","")`,
            then: [`# upstream doesn't exist, so skip`],
          },
          {
            test: `else ifeq ("$(wildcard patches/*.patch)","")`,
            then: [
              `# upstream exists, but patches don't exist. This is probably an error.`,
              `@echo "No patches found within the patch operation"`,
              `@echo "patches were expected because upstream exists"`,
              `@exit 1`,
            ]
          },
          {
            test: `else`,
            then: [
              "# Checkout the submodule at the pinned commit.",
              "# `--force`: If the submodule is at a different commit, move it to the pinned commit.",
              "# `--init`: If the submodule is not initialized, initialize it.",
              `git submodule update --force --init`,
              "# Iterating over the patches folder in sorted order,",
              "# apply the patch using a 3-way merge strategy. This mirrors the default behavior of `git merge`",
              [
                `cd upstream`,
                `for patch in $(sort $(wildcard patches/*.patch)); do git apply --3way ../$$patch || exit 1; done`
              ]
            ]
          },
        ],
        end: "endif",
      }]
    };

    startPatch = {
      name: "start-patch",
      phony: true,
      dependencies: [upstream],
      commands: [{
        parts: [
          {
            test: `ifeq ("$(wildcard upstream)","")`,
            then: [`@echo "No upstream found, so upstream can't be patched"`, `@exit 1`],
          },
          {
            test: `else`,
            then: [
              `# To add an additional patch:`,
              `#`,
              "#	1. Run this command (`make start-patch`).",
              `#`,
              "#	2. Edit the `upstream` repo, making whatever changes you want to appear in the new",
              `#	patch. It's fine to edit multiple files.`,
              `#`,
              `#	3. Commit your changes. The slugified first line of your commit description will`,
              `#	be used to generate the patch file name. Only the diff from the latest commit will`,
              `#	end up in the final patch.`,
              `#`,
              "#	4. Run `make finish-patch`.",
              `#`,
              "# It is safe to run `make start-patch` as many times as you want, but any changes",
              "# might be reverted until `make finish-patch` is run.",
              `@cd upstream && git commit --quiet -m "existing patches"`,
            ],
          },
        ],
        end: "endif",
      }]
    }
    finishPatch = {
      name: "finish-patch",
      phony: true,
      commands: [
        `@if [ ! -z "$$(cd upstream && git status --porcelain)" ]; then echo "Please commit your changes before finishing the patch"; exit 1; fi`,
        [
          "@cd upstream",
          `git format-patch HEAD~ -o ../patches --start-number $$(($$(ls ../patches | wc -l | xargs)+1))`,
        ],
      ],
    }
  }


  const tfgen: Target = {
    name: "tfgen",
    phony: true,
    dependencies: [install_plugins, upstream],
    commands: [
      '(cd provider && go build -p 1 -o $(WORKING_DIR)/bin/$(TFGEN) -ldflags "-X $(PROJECT)/$(VERSION_PATH)=$(VERSION)" $(PROJECT)/$(PROVIDER_PATH)/cmd/$(TFGEN))',
      "$(WORKING_DIR)/bin/$(TFGEN) schema --out provider/cmd/$(PROVIDER)",
      "(cd provider && VERSION=$(VERSION) go generate cmd/$(PROVIDER)/main.go)",
    ],
  };

  if (config.provider == "docker") {
    tfgen.dependencies = [install_plugins, docs];
  }

  const ldFlagStatements = ["-X $(PROJECT)/$(VERSION_PATH)=$(VERSION)"];
  if (config.providerVersion) {
    ldFlagStatements.push(`-X ${config.providerVersion}=$(VERSION)`);
  }
  const ldflags = ldFlagStatements.join(" ");
  const provider: Target = {
    name: "provider",
    phony: true,
    dependencies: [tfgen, install_plugins],
    commands: [
      `(cd provider && go build -p 1 -o $(WORKING_DIR)/bin/$(PROVIDER) -ldflags "${ldflags}" $(PROJECT)/$(PROVIDER_PATH)/cmd/$(PROVIDER))`,
    ],
  };
  const build_nodejs: Target = {
    name: "build_nodejs",
    phony: true,
    dependencies: [upstream],
    variables: {
      VERSION: "$(shell pulumictl get version --language javascript)",
    },
    commands: [
      "$(WORKING_DIR)/bin/$(TFGEN) nodejs --out sdk/nodejs/",
      [
        "cd sdk/nodejs/",
        'echo "module fake_nodejs_module // Exclude this directory from Go tools\\n\\ngo 1.17" > go.mod',
        "yarn install",
        "yarn run tsc",
        "cp ../../README.md ../../LICENSE* package.json yarn.lock ./bin/",
        'sed -i.bak -e "s/\\$${VERSION}/$(VERSION)/g" ./bin/package.json',
      ],
    ],
  };
  const build_python: Target = {
    name: "build_python",
    phony: true,
    dependencies: [upstream],
    variables: {
      PYPI_VERSION: "$(shell pulumictl get version --language python)",
    },
    commands: [
      "$(WORKING_DIR)/bin/$(TFGEN) python --out sdk/python/",
      [
        "cd sdk/python/",
        'echo "module fake_python_module // Exclude this directory from Go tools\\n\\ngo 1.17" > go.mod',
        "cp ../../README.md .",
        "python3 setup.py clean --all 2>/dev/null",
        "rm -rf ./bin/ ../python.bin/ && cp -R . ../python.bin && mv ../python.bin ./bin",
        `sed -i.bak -e 's/^VERSION = .*/VERSION = "$(PYPI_VERSION)"/g' -e 's/^PLUGIN_VERSION = .*/PLUGIN_VERSION = "$(VERSION)"/g' ./bin/setup.py`,
        "rm ./bin/setup.py.bak && rm ./bin/go.mod",
        "cd ./bin && python3 setup.py build sdist",
      ],
    ],
  };
  const build_go: Target = {
    name: "build_go",
    phony: true,
    dependencies: [upstream],
    commands: [
      "$(WORKING_DIR)/bin/$(TFGEN) go --out sdk/go/",
      // The following pulls out the `module` line from go.mod to determine the right
      // module prefix path for the SDK (including versions etc.), then runs a `go list`
      // to determine all packages under the SDK. Finally, this issues a go build on all
      // the packages discovered.
      `cd sdk && go list \`grep -e "^module" go.mod | cut -d ' ' -f 2\`/go/... | xargs go build`,
    ],
  };
  const build_dotnet: Target = {
    name: "build_dotnet",
    phony: true,
    variables: {
      DOTNET_VERSION: "$(shell pulumictl get version --language dotnet)",
    },
    dependencies: [upstream],
    commands: [
      "pulumictl get version --language dotnet",
      "$(WORKING_DIR)/bin/$(TFGEN) dotnet --out sdk/dotnet/",
      [
        "cd sdk/dotnet/",
        'echo "module fake_dotnet_module // Exclude this directory from Go tools\\n\\ngo 1.17" > go.mod',
        'echo "$(DOTNET_VERSION)" >version.txt',
        "dotnet build /p:Version=$(DOTNET_VERSION)",
      ],
    ],
  };
  const bin_pulumi_java_gen: Target = {
    name: "bin/pulumi-java-gen",
    commands: [
      "$(shell pulumictl download-binary -n pulumi-language-java -v $(JAVA_GEN_VERSION) -r pulumi/pulumi-java)",
    ],
  };
  const build_java: Target = {
    name: "build_java",
    phony: true,
    dependencies: [bin_pulumi_java_gen, upstream],
    variables: {
      PACKAGE_VERSION: "$(shell pulumictl get version --language generic)",
    },
    commands: [
      "$(WORKING_DIR)/bin/$(JAVA_GEN) generate --schema provider/cmd/$(PROVIDER)/schema.json --out sdk/java  --build gradle-nexus",
      [
        "cd sdk/java/",
        'echo "module fake_java_module // Exclude this directory from Go tools\\n\\ngo 1.17" > go.mod',
        "gradle --console=plain build",
      ],
    ],
  };
  const build_sdks: Target = {
    name: "build_sdks",
    phony: true,
    dependencies: [
      build_nodejs,
      build_python,
      build_go,
      build_dotnet,
      build_java,
    ],
  };
  const lint_provider: Target = {
    name: "lint_provider",
    phony: true,
    dependencies: [provider],
    commands: ["cd provider && golangci-lint run -c ../.golangci.yml"],
  };
  const cleanup: Target = {
    name: "cleanup",
    phony: true,
    commands: [
      "rm -r $(WORKING_DIR)/bin",
      "rm -f provider/cmd/$(PROVIDER)/schema.go",
    ],
  };
  const help: Target = {
    name: "help",
    commands: [
      "@grep '^[^.#]\\+:\\s\\+.*#' Makefile | \\",
      'sed "s/\\(.\\+\\):\\s*\\(.*\\) #\\s*\\(.*\\)/`printf "\\033[93m"`\\1`printf "\\033[0m"`	\\3 [\\2]/" | \\',
      "expand -t20",
    ],
    phony: true,
  };
  const clean: Target = {
    name: "clean",
    phony: true,
    commands: ["rm -rf sdk/{dotnet,nodejs,go,python}"],
  };
  const install_dotnet_sdk: Target = {
    name: "install_dotnet_sdk",
    phony: true,
    commands: [
      "mkdir -p $(WORKING_DIR)/nuget",
      "find . -name '*.nupkg' -print -exec cp -p {} $(WORKING_DIR)/nuget \\;",
    ],
  };
  const install_python_sdk: Target = {
    name: "install_python_sdk",
    phony: true,
  };
  const install_java_sdk: Target = {
    name: "install_java_sdk",
    phony: true,
  };
  const install_go_sdk: Target = { name: "install_go_sdk", phony: true };
  const install_nodejs_sdk: Target = {
    name: "install_nodejs_sdk",
    phony: true,
    commands: ["yarn link --cwd $(WORKING_DIR)/sdk/nodejs/bin"],
  };
  const install_sdks: Target = {
    name: "install_sdks",
    phony: true,
    dependencies: [
      install_dotnet_sdk,
      install_python_sdk,
      install_nodejs_sdk,
      install_java_sdk,
    ],
  };
  const defaultTarget: Target = {
    name: "development",
    phony: true,
    dependencies: [install_plugins, provider, build_sdks, install_sdks],
  };
  const build: Target = {
    name: "build",
    phony: true,
    dependencies: [install_plugins, provider, build_sdks, install_sdks],
  };
  const only_build: Target = {
    name: "only_build",
    dependencies: [build],
    phony: true,
  };
  const test: Target = {
    name: "test",
    phony: true,
    commands: [
      "cd examples && go test -v -tags=all -parallel $(TESTPARALLELISM) -timeout 2h",
    ],
  };

  const targets = [
    upstream,
    startPatch,
    finishPatch,
    build,
    only_build,
    tfgen,
    provider,
    build_sdks,
    build_nodejs,
    build_python,
    build_go,
    build_dotnet,
    build_java,
    bin_pulumi_java_gen,
    lint_provider,
    cleanup,
    help,
    clean,
    install_plugins,
    install_dotnet_sdk,
    install_python_sdk,
    install_go_sdk,
    install_java_sdk,
    install_nodejs_sdk,
    install_sdks,
    test,
  ].filter((x): x is Target => x !== null);


  if (config.hybrid) {
    targets.push(docs);
  }

  return {
    variables,
    defaultTarget,
    targets,
  };
}