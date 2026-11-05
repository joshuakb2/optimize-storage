{
  description = "A tool for finding and hard-linking duplicate files";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";
  };

  outputs = inputs: {
    packages = builtins.mapAttrs (system: pkgs: {
      optimize-storage = pkgs.callPackage nix/package.nix { };
      default = inputs.self.packages.${system}.optimize-storage;
    }) inputs.nixpkgs.legacyPackages;

    devShells = builtins.mapAttrs (system: pkgs: {
      default = pkgs.mkShell {
        name = "optimize-storage";
        inputsFrom = [ inputs.self.packages.${system}.optimize-storage ];
      };
    }) inputs.nixpkgs.legacyPackages;
  };
}
