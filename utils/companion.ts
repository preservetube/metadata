import { type WriteStream } from 'node:fs';
import * as hr from '@tsmx/human-readable'

interface StreamResults {
  videoStreamUrl: string;
  audioStreamUrl: string;
  selectedFormats: {
    videoFormat: any;
    audioFormat: any;
  }
}

export async function getVideoStreams(
  videoId: string,
  adaptiveFormats: any[], 
  options: { videoQuality: string; audioQuality: string }
): Promise<{
  streamResults: StreamResults | false;
  error?: string
}> {
  const lowestStorageVideo = adaptiveFormats
    .filter((format) => !!format.quality_label?.toLowerCase().includes(options.videoQuality?.toLowerCase() || ''))
    .sort((a, b) => (a.contentLength || 0) - (b.contentLength || 0))?.[0]
  const lowestStorageAudio = adaptiveFormats
    .filter((format) => !!format.audio_quality?.toLowerCase().includes(options.audioQuality?.toLowerCase() || ''))
    .sort((a, b) => (a.contentLength || 0) - (b.contentLength || 0))?.[0]
  const lowestOptions = {
    videoFormat: lowestStorageVideo?.itag,
    audioFormat: lowestStorageAudio?.itag
  }

  if (!lowestOptions.videoFormat || !lowestOptions.audioFormat) {
    return { streamResults: false, error: 'Couldn\'t find any suitable download formats.' }
  }

  const {
    videoStreamUrl,
    audioStreamUrl
  } = {
    videoStreamUrl: await getStreamUrl(videoId, lowestOptions.videoFormat),
    audioStreamUrl: await getStreamUrl(videoId, lowestOptions.audioFormat)
  }

  if (!videoStreamUrl || !audioStreamUrl) return { streamResults: false, error: 'Failed to fetch streaming URLs from Youtube.' }

  return {
    streamResults: {
      videoStreamUrl,
      audioStreamUrl,
      selectedFormats: {
        videoFormat: lowestStorageVideo,
        audioFormat: lowestStorageAudio
      }
    },
  }
}

export async function downloadStream(streamUrl: string, format: any, stream: WriteStream, ws: any, type: string) {
  // get the final url of the stream, since it redirects
  let location = streamUrl
  let headResponse: Response | undefined;
  const headersToSend: HeadersInit = {
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-us,en;q=0.5",
    "origin": "https://www.youtube.com",
    "referer": "https://www.youtube.com",
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  };

  for (let i = 0; i < 5; i++) {
    const googlevideoResponse: Response = await fetch(location, {
      method: "HEAD",
      headers: headersToSend,
      redirect: "manual",
    });
    if (googlevideoResponse.status == 403) {
      throw new Error(`403 from google - ${await googlevideoResponse.text()}`)
    }
    if (googlevideoResponse.headers.has("Location")) {
      location = googlevideoResponse.headers.get("Location") as string;
      continue;
    } else {
      headResponse = googlevideoResponse;
      break;
    }
  }

  if (headResponse === undefined) {
    throw new Error('google redirected too many times')
  }

  // setup the chunking setup. 
  const googleVideoUrl = new URL(location);
  let size = 0;
  const totalSize = Number(headResponse.headers.get("Content-Length") || format.content_length || "0")
  const videoStartTime = Date.now();
  const videoPrecentages: string[] = []

  const getChunk = async (start: number, end: number) => {
    googleVideoUrl.searchParams.set(
      "range",
      `${start}-${end}`,
    );
    const postResponse = await fetch(googleVideoUrl, {
      method: "POST",
      body: new Uint8Array([0x78, 0]), // protobuf: { 15: 0 } (no idea what it means but this is what YouTube uses),
      headers: headersToSend,
    });
    if (postResponse.status !== 200) {
      throw new Error("Non-200 response from google servers");
    }

    const chunk = Buffer.from(await postResponse.arrayBuffer())
    stream.write(chunk);

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
  };

  const chunkSize = 5 * 1_000_000 // 5mb
  const wholeRequestEndByte = Number(totalSize) - 1;
    
  for (let startByte = 0; startByte < wholeRequestEndByte; startByte += chunkSize) {
    let endByte = startByte + chunkSize - 1;
    if (endByte > wholeRequestEndByte) {
      endByte = wholeRequestEndByte;
    }
    await getChunk(startByte, endByte)
  }

  stream.end()
}

async function getStreamUrl(videoId: string, itag: number): Promise<string|false> {
  const req = await fetch(`http://127.0.0.1:8282/companion/latest_version?id=${videoId}&itag=${itag}`, {
    redirect: 'manual'
  })

  if (req.status == 302) {
    return req.headers.get('Location')!
  }

  return false
}

function secondsToTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  const formattedSeconds = remainingSeconds < 10 ? '0' + remainingSeconds : remainingSeconds;
  return `${minutes}:${formattedSeconds}`;
}