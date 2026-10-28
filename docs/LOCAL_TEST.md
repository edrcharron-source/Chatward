# Try Chatward on your Windows PC

You only need **Docker Desktop**. No Git, no Node, no coding tools.

## One-time setup
1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop) and open it. Wait until it says it's running.
2. Go to the [Releases page](https://github.com/edrcharron-source/Chatward/releases) and download two files from the newest release:
   - `Chatward-Setup.exe` (the app)
   - `chatward-server.zip` (the server)
3. Unzip `chatward-server.zip` anywhere (for example your Desktop), open the `chatward-server` folder, and double-click **`start-server.bat`**. The first run takes a few minutes while it sets itself up. When it says the server is running, you can close that window.
4. Run `Chatward-Setup.exe`. Windows may warn "unknown publisher" because the app isn't code-signed yet: click **More info → Run anyway**.

## Using it
- Open Chatward. The server address is already `http://localhost:3000`.
- Click **Register**. The first account needs no invite. Create a server, then make an invite code from the server menu.
- Voice, screen share and the soundboard work from the voice channel. Use headphones to avoid echo.

## Testing with a second "person" on the same PC
Run the app a second time with its own profile: press Win+R and paste
`"%LOCALAPPDATA%\Programs\Chatward\Chatward.exe" --user-data-dir=%TEMP%\chatward2`
then register with the invite code. (If it can't find the file, right-click the Chatward shortcut → Properties and copy its path.)

## GIFs (optional)
Get a free API key from klipy.com, copy `.env.example` to `.env` in the server folder, paste the key after `KLIPY_API_KEY=`, and run `start-server.bat` again.

## Stopping / resetting
- `stop-server.bat` stops the server; your chats are kept.
- To wipe everything: in Docker Desktop, delete the `chatward-server` containers and volume.

## Known gaps
This is an early build: voice, camera, screen share and the soundboard in a call have not been tested on a real PC yet, so tell us what breaks. The encryption is being upgraded to MLS.
