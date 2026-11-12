// Small ARC bridge for APIs whose audio blocks are most naturally expressed in
// Objective-C. All recognizer lifecycle state is confined to the main queue.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

typedef void (*DFSpeechCallback)(void *, uint32_t, const char *, bool, double);
typedef void (*DFSpeechRelease)(void *);

@interface DFSpeech : NSObject
@property(nonatomic) void *context;
@property(nonatomic) DFSpeechCallback callback;
@property(nonatomic) DFSpeechRelease releaseContext;
@property(nonatomic, copy) NSString *locale;
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic) BOOL tapped;
@property(nonatomic) BOOL ended;
@property(nonatomic) BOOL stopping;
@property(nonatomic) NSTimeInterval lastLevel;
- (void)begin;
- (void)stop;
- (void)cancel;
@end

@implementation DFSpeech
- (void)dealloc {
    if (_releaseContext) _releaseContext(_context);
}
- (void)emit:(uint32_t)kind text:(NSString *)text final:(BOOL)final level:(double)level {
    if (!self.ended) self.callback(self.context, kind, text.UTF8String, final, level);
}
- (void)stopAudio {
    [self.engine stop];
    if (self.tapped) {
        [self.engine.inputNode removeTapOnBus:0];
        self.tapped = NO;
    }
}
- (void)finish {
    if (self.ended) return;
    [self stopAudio];
    [self emit:3 text:nil final:NO level:0];
    self.ended = YES;
    [self.task cancel];
    self.task = nil;
    self.request = nil;
    self.engine = nil;
    self.recognizer = nil;
}
- (void)fail:(uint32_t)code message:(NSString *)message {
    [self emit:code text:message final:NO level:0];
    [self finish];
}
- (void)begin {
    if (self.ended) return;
    NSBundle *bundle = NSBundle.mainBundle;
    if (![bundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"] ||
        ![bundle objectForInfoDictionaryKey:@"NSSpeechRecognitionUsageDescription"]) {
        [self fail:5 message:@"The application lacks microphone or speech permission descriptions."];
        return;
    }
    __weak DFSpeech *weakSelf = self;
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{
            DFSpeech *self = weakSelf;
            if (!self || self.ended) return;
            if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                [self fail:4 message:@"Speech recognition permission was denied."];
                return;
            }
            [self requestMicrophone];
        });
    }];
}
- (void)requestMicrophone {
    __weak DFSpeech *weakSelf = self;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            DFSpeech *self = weakSelf;
            if (!self || self.ended) return;
            if (!granted) {
                [self fail:4 message:@"Microphone permission was denied."];
                return;
            }
            @try {
                [self startAudio];
            } @catch (NSException *exception) {
                [self fail:8 message:exception.reason ?: @"Unable to configure microphone capture."];
            }
        });
    }];
}
- (void)startAudio {
    self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:self.locale]];
    if (!self.recognizer || !self.recognizer.available) {
        [self fail:5 message:@"Speech recognition is unavailable for this language."];
        return;
    }
    self.engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = self.engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.channelCount == 0 || format.sampleRate == 0) {
        [self fail:5 message:@"No microphone is available."];
        return;
    }
    self.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    self.request.shouldReportPartialResults = YES;
    self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
    __weak DFSpeech *weakSelf = self;
    self.task = [self.recognizer recognitionTaskWithRequest:self.request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            DFSpeech *self = weakSelf;
            if (!self || self.ended) return;
            if (result) {
                NSString *text = result.bestTranscription.formattedString;
                if (result.final && text.length == 0) {
                    [self fail:6 message:@"No speech was recognized."];
                    return;
                }
                [self emit:1 text:text final:result.final level:0];
                if (result.final) { [self finish]; return; }
            }
            if (error) {
                uint32_t code = [error.domain isEqualToString:NSURLErrorDomain] ? 7 : 8;
                if ([error.domain isEqualToString:@"kAFAssistantErrorDomain"] && error.code == 1110) code = 6;
                [self fail:code message:error.localizedDescription];
            }
        });
    }];
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    // This overload supports the desktop app's pre-macOS-27 deployment targets.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        (void)when;
        [request appendAudioPCMBuffer:buffer];
        float *samples = buffer.floatChannelData ? buffer.floatChannelData[0] : NULL;
        double sum = 0;
        if (samples && buffer.frameLength > 0) {
            for (AVAudioFrameCount index = 0; index < buffer.frameLength; ++index) sum += samples[index] * samples[index];
            // Map -60 dB..0 dB to a stable display level; audio stays in native code.
            double rms = sqrt(sum / buffer.frameLength);
            double level = fmax(0, fmin(1, (20 * log10(fmax(rms, 0.000001)) + 60) / 60));
            dispatch_async(dispatch_get_main_queue(), ^{
                DFSpeech *self = weakSelf;
                if (!self || self.ended || self.stopping) return;
                NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
                if (now - self.lastLevel >= 0.08) {
                    self.lastLevel = now;
                    [self emit:2 text:nil final:NO level:level];
                }
            });
        }
    }];
#pragma clang diagnostic pop
    self.tapped = YES;
    [self.engine prepare];
    NSError *error = nil;
    if (![self.engine startAndReturnError:&error]) {
        [self fail:8 message:error.localizedDescription ?: @"Unable to start microphone capture."];
        return;
    }
    [self emit:0 text:nil final:NO level:0];
}
- (void)stop {
    if (self.ended || self.stopping) return;
    self.stopping = YES;
    if (!self.task) { [self finish]; return; }
    [self stopAudio];
    [self.request endAudio];
    __weak DFSpeech *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        DFSpeech *self = weakSelf;
        if (self && !self.ended) [self fail:8 message:@"Speech recognition did not finish."];
    });
}
- (void)cancel { [self finish]; }
@end

bool df_speech_supported(const char *locale) {
    NSString *identifier = [NSString stringWithUTF8String:locale];
    __block BOOL supported = NO;
    void (^check)(void) = ^{
        if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"] ||
            ![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSSpeechRecognitionUsageDescription"]) return;
        // The recognizer resolves valid BCP-47 aliases such as zh-Hans-CN to
        // its supported zh-CN locale. Comparing locale strings rejects these.
        SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc]
            initWithLocale:[NSLocale localeWithLocaleIdentifier:identifier]];
        supported = recognizer != nil;
    };
    if (NSThread.isMainThread) check();
    else dispatch_sync(dispatch_get_main_queue(), check);
    return supported;
}

void *df_speech_create(const char *locale, void *context, DFSpeechCallback callback, DFSpeechRelease release) {
    DFSpeech *speech = [[DFSpeech alloc] init];
    speech.locale = [NSString stringWithUTF8String:locale];
    speech.context = context;
    speech.callback = callback;
    speech.releaseContext = release;
    dispatch_async(dispatch_get_main_queue(), ^{ [speech begin]; });
    return (__bridge_retained void *)speech;
}
void df_speech_stop(void *pointer) {
    DFSpeech *speech = (__bridge DFSpeech *)pointer;
    dispatch_async(dispatch_get_main_queue(), ^{ [speech stop]; });
}
void df_speech_cancel(void *pointer) {
    DFSpeech *speech = (__bridge DFSpeech *)pointer;
    dispatch_async(dispatch_get_main_queue(), ^{ [speech cancel]; });
}
void df_speech_release(void *pointer) {
    DFSpeech *speech = (__bridge_transfer DFSpeech *)pointer;
    dispatch_async(dispatch_get_main_queue(), ^{ [speech cancel]; });
}
