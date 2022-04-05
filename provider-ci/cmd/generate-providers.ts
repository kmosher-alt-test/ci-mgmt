import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import * as yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { buildProviderFiles, ProviderFile } from "../src/provider";

export const providersDir = "providers";

const args = yargs(hideBin(process.argv))
  .command("generate-providers", "generate the providers")
  .option("name", {
    description: "Provider name to generate",
    type: "string",
    array: true,
    alias: "n",
  })
  .option("debug", {
    description: "Enable debug logging",
    type: "boolean",
  })
  .parseSync();

const debug = (message?: any, ...optionalParams: any[]) => {
  if (args.debug) {
    console.log(message, ...optionalParams);
  }
};

const getProviders = (names: string[] | undefined) => {
  const providers = fs
    .readdirSync(providersDir, { withFileTypes: true })
    .filter((dir) => dir.isDirectory)
    .map((dir) => dir.name);

  const providerSet = new Set(providers);
  const unknown = names?.filter((n) => !providerSet.has(n)) ?? [];
  if (unknown?.length > 0) {
    throw new Error(`Unknown providers ${unknown?.join(", ")}`);
  }

  const nameSet = new Set(names);
  if (names !== undefined) {
    return providers.filter((n) => nameSet.has(n));
  }
  return providers;
};

interface Provider {
  name: string;
  files: ProviderFile[];
}

const writeProviderFiles = (provider: Provider) => {
  const providerRepoPath = path.join(providersDir, provider.name, "repo");
  if (fs.existsSync(providerRepoPath)) {
    fs.rmSync(providerRepoPath, { recursive: true });
  }
  fs.mkdirSync(providerRepoPath, { recursive: true });
  for (const file of provider.files) {
    const filePath = path.join(providerRepoPath, file.path);
    const yamlContent = yaml.stringify(file.data, {
      sortMapEntries: true,
      indentSeq: false,
    });
    debug("Writing", filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, yamlContent, { encoding: "utf-8" });
  }
};

const providerNames = getProviders(args.name);
debug("providers to generate", providerNames);

const providerFiles = providerNames.map((providerName) => ({
  name: providerName,
  files: buildProviderFiles(providerName),
}));
providerFiles.forEach(writeProviderFiles);
