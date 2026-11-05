{ buildNpmPackage, lib }:

buildNpmPackage {
  name = "optimize-storage";
  src = lib.cleanSource ../.;
  npmDepsHash = "sha256-R2IoVm/nhUGsGqv6Jb/l2Yg7JoDKgXceRu3TapooW6E=";
}
