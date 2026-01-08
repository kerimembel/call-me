import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('CallMe extension is now active!');

    // Register Call User command
    let callUserDisposable = vscode.commands.registerCommand('callme.callUser', async (message?: string) => {
        if (!message) {
            message = await vscode.window.showInputBox({ prompt: 'What should the AI say?' });
        }

        if (!message) return;

        try {
            const config = vscode.workspace.getConfiguration('callme');
            const serverUrl = config.get<string>('serverUrl');

            if (!serverUrl) {
                vscode.window.showErrorMessage('CallMe Server URL is not configured.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Initiating Phone Call...",
                cancellable: false
            }, async () => {
                const response = await fetch(`${serverUrl}/api/call`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });

                if (!response.ok) {
                    throw new Error(`Server returned ${response.status}`);
                }

                const result = await response.json() as any;
                vscode.window.showInformationMessage(`Call finished. Response: ${result.response}`);
                return result.response; // Return for programmatic usage
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to call user: ${error.message}`);
            throw error;
        }
    });

    // Register Telegram Ask command
    let telegramAskDisposable = vscode.commands.registerCommand('callme.telegramAsk', async (message?: string) => {
        if (!message) {
            message = await vscode.window.showInputBox({ prompt: 'What question to ask via Telegram?' });
        }

        if (!message) return;

        try {
            const config = vscode.workspace.getConfiguration('callme');
            const serverUrl = config.get<string>('serverUrl');

            if (!serverUrl) {
                vscode.window.showErrorMessage('CallMe Server URL is not configured.');
                return;
            }

            const answer = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Waiting for Telegram reply...",
                cancellable: true
            }, async (progress, token) => {
                const response = await fetch(`${serverUrl}/api/telegram/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });

                if (!response.ok) {
                    throw new Error(`Server returned ${response.status}`);
                }

                const result = await response.json() as any;
                return result.response;
            });

            vscode.window.showInformationMessage(`Telegram Reply: ${answer}`);
            return answer; // Return for programmatic usage (e.g. by Agent)

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to message user: ${error.message}`);
            throw error;
        }
    });

    context.subscriptions.push(callUserDisposable);
    context.subscriptions.push(telegramAskDisposable);
}

export function deactivate() {}
