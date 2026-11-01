#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

int main(int argc, char *argv[]) {
    // Build command line with proper quoting
    char cmdLine[8192];
    snprintf(cmdLine, sizeof(cmdLine), "\"C:\\Python314\\python.exe\" \"D:\\Mazz Code\\MAZZ_AGENT_STUDIO\\scripts\\hermes_agent_cli.py\"");

    for (int i = 1; i < argc; i++) {
        strncat(cmdLine, " ", sizeof(cmdLine) - strlen(cmdLine) - 1);
        if (strchr(argv[i], ' ') != NULL) {
            strncat(cmdLine, "\"", sizeof(cmdLine) - strlen(cmdLine) - 1);
            strncat(cmdLine, argv[i], sizeof(cmdLine) - strlen(cmdLine) - 1);
            strncat(cmdLine, "\"", sizeof(cmdLine) - strlen(cmdLine) - 1);
        } else {
            strncat(cmdLine, argv[i], sizeof(cmdLine) - strlen(cmdLine) - 1);
        }
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(
        NULL,
        cmdLine,
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &si,
        &pi
    )) {
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return (int)exitCode;
}
