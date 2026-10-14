# Setting up WSL2 and Docker (needed from milestone M1)

**Why:** M1 runs tools that need Linux: the Valhalla routing engine (in Docker), osmium and GDAL. They are reliable on Linux arm64 and patchy on native Windows on ARM.

**This laptop:** Windows 11 **Home** (build 26200), Snapdragon X Elite (ARM64), 32 GB RAM.

Allow about 30–45 minutes, including one restart.

---

## Part 1: WSL2 with Ubuntu 24.04

1. **Check that virtualisation is on.** Open Task Manager → Performance → CPU and look for **Virtualization: Enabled**. Snapdragon X laptops ship with it enabled; if it says Disabled, turn it on in the UEFI/BIOS settings.

2. **Install WSL and Ubuntu.** Open PowerShell **as Administrator** (Start → type `PowerShell` → *Run as administrator*):

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

   This turns on the Windows features WSL needs and downloads Ubuntu. WSL works on Windows 11 Home.

   > **If the Ubuntu download fails with `Not found (404)` / `Wsl/InstallDistro/HTTP_E_STATUS_NOT_FOUND`:** this happened on 2026-10-14. WSL itself installs fine, but Microsoft's distribution list points the **ARM64** builds of Ubuntu 24.04 and 26.04 at URLs that don't exist; the images are under `cdimage.ubuntu.com/ubuntu/releases/…`. Install from the file instead (any folder, no admin needed):
   >
   > ```powershell
   > curl.exe -L -o "$env:USERPROFILE\Downloads\ubuntu-24.04.5-wsl-arm64.wsl" https://cdimage.ubuntu.com/ubuntu/releases/noble/release/ubuntu-24.04.5-wsl-arm64.wsl
   > (Get-FileHash "$env:USERPROFILE\Downloads\ubuntu-24.04.5-wsl-arm64.wsl" -Algorithm SHA256).Hash
   > wsl --install --from-file "$env:USERPROFILE\Downloads\ubuntu-24.04.5-wsl-arm64.wsl" --name Ubuntu-24.04
   > ```
   >
   > The hash must be `74478B5024D9047397BA79D17C27F73CAF85ADA4988F88CFFC2892D65E6A806B`, matching Ubuntu's published `SHA256SUMS` for this file (388 MB). Then run `wsl -d Ubuntu-24.04` to create your Linux user (step 4).

3. **Restart Windows** when asked.

4. **Create your Linux user.** After the restart, Ubuntu opens by itself (or start **Ubuntu 24.04** from the Start menu). Choose a Linux username and password. They are separate from your Windows login, and you'll need the password for `sudo`.

5. **Check that it is WSL 2.** In a normal PowerShell:

   ```powershell
   wsl --version
   wsl -l -v
   ```

   You should see WSL version 2.x, and `Ubuntu-24.04` with `VERSION 2`. If WSL is older than 2.1.5, run `wsl --update`.

6. **Update Ubuntu.** In the Ubuntu terminal:

   ```bash
   sudo apt update && sudo apt full-upgrade -y
   ```

7. **Give WSL enough memory for routing builds.** By default WSL gets half your RAM (16 GB). Create the file `C:\Users\cliff\.wslconfig` containing:

   ```ini
   [wsl2]
   memory=20GB
   processors=10
   swap=8GB
   ```

   Then run `wsl --shutdown` in PowerShell and reopen Ubuntu. This leaves 12 GB and 2 cores for Windows; lower `memory` if Windows feels sluggish.

8. **Check systemd is running** (Docker Engine needs it). In Ubuntu:

   ```bash
   systemctl is-system-running
   ```

   `running` or `degraded` are both fine. If you get an error or `offline`, add this to `/etc/wsl.conf` (use `sudo nano /etc/wsl.conf`), then run `wsl --shutdown` and reopen Ubuntu:

   ```ini
   [boot]
   systemd=true
   ```

---

## Part 2: Docker

### First, a caution about Docker Desktop on this laptop

Docker's install page currently lists Windows 11 **Enterprise, Pro or Education** 23H2+ for Docker Desktop; **Home is not on the list**. Its Windows-on-Arm build is also marked **Early Access**. Many people do run Docker Desktop on Home, but on this machine you would be outside Docker's supported configuration twice over.

So I recommend **Option A**. Option B is there if you particularly want Docker Desktop's GUI. **Install only one of them**, since two Docker engines conflict.

### Option A (recommended): Docker Engine inside Ubuntu

Docker Engine is free and open source, has no subscription agreement, and is officially supported on Ubuntu arm64. It is lighter than Docker Desktop. You use it from the Ubuntu terminal with the normal `docker` command; there is no GUI.

Run these in the **Ubuntu** terminal. They are Docker's official apt-repository steps:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let your user run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
```

Close Ubuntu, run `wsl --shutdown` in PowerShell, and reopen Ubuntu. Then check:

```bash
docker run --rm hello-world
docker info --format '{{.Architecture}}'   # should print aarch64
docker compose version
```

Docker starts automatically with Ubuntu (systemd). If it ever isn't running: `sudo systemctl start docker`.

### Option B: Docker Desktop

1. **Download** the Arm installer, "Docker Desktop for Windows - Arm (Early Access)", from <https://docs.docker.com/desktop/setup/install/windows-install/>. The direct link is <https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe>. Don't use the Microsoft Store listing: it is x86_64 only.
2. **Run** `Docker Desktop Installer.exe`. The default per-user install needs no admin rights. On the configuration page, choose **Use WSL 2**.
3. **Start Docker Desktop** from the Start menu. It asks you to accept the Docker Subscription Service Agreement. Docker Desktop is free for personal use and for small businesses (fewer than 250 employees *and* under US$10 million annual revenue).
4. **Connect it to Ubuntu:** Settings → Resources → WSL integration → turn on **Ubuntu-24.04** → Apply & restart.
5. **Check** in the Ubuntu terminal: `docker run --rm hello-world`.

If Docker Desktop misbehaves on Home, uninstall it and use Option A instead.

---

## Part 3: Let me know when it's done

These two commands, run in PowerShell, confirm everything:

```powershell
wsl -l -v
wsl -d Ubuntu-24.04 -- docker run --rm hello-world
```

## How M1 will use this (proposal, to confirm at the start of M1)

- **Engine and Docker run inside Ubuntu:** the Python engine, Valhalla and the OSM tools, all with native Linux arm64 builds.
- **The repository stays at `C:\Users\cliff\dev\dreamplango`,** so editing and this Claude session keep working unchanged. The engine's Linux virtualenv lives outside the repo, via `UV_PROJECT_ENVIRONMENT`, so it doesn't clash with the Windows one.
- **Large data moves to the Linux filesystem** (e.g. `~/dpg-data`, set with `DPG_DATA_DIR`). Reading from `/mnt/c` is many times slower.
- **The Node API and web viewer keep running on Windows.** They read the bundles through the `\\wsl.localhost\Ubuntu-24.04\...` path.
