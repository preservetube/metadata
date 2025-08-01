import { createWriteStream, type WriteStream } from 'node:fs';
import { Constants, Innertube, type IPlayerResponse, UniversalCache, YTNodes } from 'youtubei.js';

import { generateWebPoToken } from './webpo-helper.js';
import type { SabrFormat } from 'googlevideo/shared-types';
import type { ReloadPlaybackContext } from 'googlevideo/protos';
import { SabrStream, type SabrPlaybackOptions } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';

import * as hr from '@tsmx/human-readable'

export interface DownloadOutput {
  stream: WriteStream;
  filePath: string;
}

export interface StreamResults {
  videoStream: ReadableStream;
  audioStream: ReadableStream;
  selectedFormats: {
    videoFormat: SabrFormat;
    audioFormat: SabrFormat;
  };
  videoTitle: string;
}

/**
 * Fetches video details and streaming information from YouTube.
 */
export async function makePlayerRequest(innertube: Innertube, videoId: string, reloadPlaybackContext?: ReloadPlaybackContext): Promise<IPlayerResponse> {
  const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });

  const extraArgs: Record<string, any> = {
    playbackContext: {
      adPlaybackContext: { pyv: true },
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
        signatureTimestamp: innertube.session.player?.sts
      }
    },
    contentCheckOk: true,
    racyCheckOk: true
  };

  if (reloadPlaybackContext) {
    extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
  }

  return await watchEndpoint.call<IPlayerResponse>(innertube.actions, { ...extraArgs, parse: true });
}

export function determineFileExtension(mimeType: string): string {
  if (mimeType.includes('video')) {
    return mimeType.includes('webm') ? 'webm' : 'mp4';
  } else if (mimeType.includes('audio')) {
    return mimeType.includes('webm') ? 'webm' : 'm4a';
  }
  return 'bin';
}

export function createOutputStream(videoId: string, mimeType: string): DownloadOutput {
  const type = mimeType.includes('video') ? 'video' : 'audio';
  const extension = determineFileExtension(mimeType);
  const fileName = `./output/${videoId}_${type}.${extension}`;

  return {
    stream: createWriteStream(fileName, { flags: 'w', encoding: 'binary' }),
    filePath: fileName
  };
}

export function bytesToMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/**
 * Creates a WritableStream that tracks download progress.
 */
export function createStreamSink(format: SabrFormat, outputStream: WriteStream, ws: any, type: string) {
  let size = 0;
  const totalSize = Number(format.contentLength || 0);
  const videoStartTime = Date.now();
  const videoPrecentages: string[] = []

  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        size += chunk.length;

        if (totalSize > 0) {
          let elapsedTime = (Date.now() - videoStartTime) / 1000;
          let progress = size / totalSize;
          let speedInMBps = (size / (1024 * 1024)) / elapsedTime;
          let remainingTime = (totalSize - size) / (speedInMBps * 1024 * 1024);

          if (!videoPrecentages.includes((progress * 100).toFixed(0))) {
            videoPrecentages.push((progress * 100).toFixed(0))
            ws.send(`[${type}] ${(progress * 100).toFixed(2)}% of ${hr.fromBytes(totalSize, {})} at ${speedInMBps.toFixed(2)} MB/s ETA ${secondsToTime(parseInt(remainingTime.toFixed(0)))}`)
          }
        }

        outputStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      outputStream.end();
    }
  });
}

/**
 * Initializes Innertube client and sets up SABR streaming for a YouTube video.
 */
export async function createSabrStream(
  videoId: string,
  options: SabrPlaybackOptions
): Promise<{
  innertube: Innertube;
  streamResults: StreamResults;
}> {
  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const webPoTokenResult = await generateWebPoToken(innertube.session.context.client.visitorData || '');

  // Get video metadata.
  const playerResponse = await makePlayerRequest(innertube, videoId);
  const videoTitle = playerResponse.video_details?.title || 'Unknown Video';

  // Now get the streaming information.
  const serverAbrStreamingUrl = innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
  const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

  if (!videoPlaybackUstreamerConfig) throw new Error('ustreamerConfig not found');
  if (!serverAbrStreamingUrl) throw new Error('serverAbrStreamingUrl not found');

  const sabrFormats = playerResponse.streaming_data?.adaptive_formats
    .filter(f => {
      if (f.is_auto_dubbed) return false 
      if (f.audio_track) {
        if (!f.audio_track.audio_is_default) return false 
        if (!f.audio_track.display_name.endsWith('original')) return false 
      } 
      return true
    })
    .map(buildSabrFormat) || [];

  const serverAbrStream = new SabrStream({
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: webPoTokenResult.poToken,
    clientInfo: {
      clientName: parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]),
      clientVersion: innertube.session.context.client.clientVersion
    }
  });

  // Handle player response reload events (e.g, when IP changes, or formats expire).
  serverAbrStream.on('reloadPlayerResponse', async (reloadPlaybackContext) => {
    const playerResponse = await makePlayerRequest(innertube, videoId, reloadPlaybackContext);

    const serverAbrStreamingUrl = innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
    const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

    if (serverAbrStreamingUrl && videoPlaybackUstreamerConfig) {
      serverAbrStream.setStreamingURL(serverAbrStreamingUrl);
      serverAbrStream.setUstreamerConfig(videoPlaybackUstreamerConfig);
    }
  });

  const { videoStream, audioStream, selectedFormats } = await serverAbrStream.start(options);

  return {
    innertube,
    streamResults: {
      videoStream,
      audioStream,
      selectedFormats,
      videoTitle
    }
  };
}

function secondsToTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  const formattedSeconds = remainingSeconds < 10 ? '0' + remainingSeconds : remainingSeconds;
  return `${minutes}:${formattedSeconds}`;
}