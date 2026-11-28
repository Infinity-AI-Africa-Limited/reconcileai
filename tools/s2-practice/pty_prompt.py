#!/usr/bin/env python3
"""Run one command under a pseudo-terminal and answer its password prompt.

Usage: pty_prompt.py COMMAND [ARG...]   (the secret is read from stdin, one line)

This is how the practice proves the profile's hidden prompt: mysqldump and mysql
are given a bare --password, so they ask on the terminal, and the secret travels
only through this process's stdin and the terminal. It never appears in a
command line, a file, an environment variable or a log.

Exit status: the command's own, or 124 if it never asked within PROMPT_TIMEOUT
seconds, or 125 if it asked more than once (a wrong password re-prompting must
fail, not loop).
"""
import os
import pty
import select
import sys
import time

PROMPT = b"Enter password:"
PROMPT_TIMEOUT = 120


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty_prompt.py COMMAND [ARG...]  (secret on stdin)", file=sys.stderr)
        return 2
    secret = sys.stdin.readline().rstrip("\n").encode()
    if not secret:
        print("pty_prompt: no secret on stdin", file=sys.stderr)
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])

    pending = b""
    prompts = 0
    deadline = time.monotonic() + PROMPT_TIMEOUT
    while True:
        if prompts == 0 and time.monotonic() > deadline:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
            print("pty_prompt: no password prompt appeared", file=sys.stderr)
            return 124
        ready, _, _ = select.select([fd], [], [], 1.0)
        if fd not in ready:
            continue
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        pending += data
        if PROMPT in pending:
            prompts += 1
            if prompts > 1:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
                print("pty_prompt: asked for the password twice", file=sys.stderr)
                return 125
            before, _, after = pending.partition(PROMPT)
            sys.stderr.buffer.write(before)
            os.write(fd, secret + b"\n")
            secret = b""
            pending = after
        # Relay everything except the prompt itself, so errors stay visible.
        elif len(pending) > len(PROMPT):
            sys.stderr.buffer.write(pending[: -len(PROMPT)])
            pending = pending[-len(PROMPT) :]
    sys.stderr.buffer.write(pending)
    sys.stderr.flush()
    _, status = os.waitpid(pid, 0)
    if prompts == 0:
        print("pty_prompt: the command exited without asking for the password", file=sys.stderr)
        return 124
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
