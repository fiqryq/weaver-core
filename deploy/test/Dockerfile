# A fresh Debian VPS with systemd as PID 1, for testing weaver-vps-setup.sh. Started by run.sh.
FROM debian:bookworm

ENV container=docker
ARG DEBIAN_FRONTEND=noninteractive

# systemd and what a typical VPS image already has (an SSH server, curl, Python).
# The rest is preinstalled only to make repeated runs faster; the setup script still installs it.
# x11-utils is for the checks only (xwininfo finds the browser's window).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus ca-certificates curl openssh-server iproute2 procps python3 \
    sudo ufw iptables sqlite3 openssl xvfb fluxbox x11vnc novnc websockify python3-venv x11-utils \
  && rm -rf /var/lib/apt/lists/*

# Units that make no sense in a container.
RUN systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service \
    systemd-udevd.service systemd-udev-trigger.service systemd-modules-load.service \
    sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
