const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

function sidecarPath(videoPath) {
  return videoPath.replace(/\.[^./\\]+$/, '') + '.telestration.json';
}

function playInfoPath(videoPath) {
  return videoPath.replace(/\.[^./\\]+$/, '') + '.meta.json';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('open-files', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open video files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('read-notes', async (_evt, videoPath) => {
  try {
    const text = await fs.readFile(sidecarPath(videoPath), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
});

ipcMain.handle('write-notes', async (_evt, videoPath, data) => {
  await fs.writeFile(sidecarPath(videoPath), JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('read-play-info', async (_evt, videoPath) => {
  try {
    const text = await fs.readFile(playInfoPath(videoPath), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
