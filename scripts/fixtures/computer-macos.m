#import <Cocoa/Cocoa.h>

@interface PreviewHandler : NSObject
@property NSTextField *input;
@property NSTextField *output;
- (void)preview:(id)sender;
@end
@implementation PreviewHandler
- (void)preview:(id)sender { self.output.stringValue = [@"Preview: " stringByAppendingString:self.input.stringValue]; }
@end

int main(void) {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 420, 260)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Plainwright Computer Fixture";
    NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(30, 160, 350, 28)];
    input.placeholderString = @"Message";
    input.accessibilityLabel = @"Message";
    NSTextField *output = [NSTextField labelWithString:@"Ready"];
    output.frame = NSMakeRect(30, 45, 350, 28);
    output.accessibilityLabel = @"Preview output";
    NSButton *check = [NSButton checkboxWithTitle:@"Enable preview" target:nil action:nil];
    check.frame = NSMakeRect(30, 115, 180, 26);
    PreviewHandler *handler = [PreviewHandler new];
    handler.input = input; handler.output = output;
    NSButton *button = [NSButton buttonWithTitle:@"Preview" target:handler action:@selector(preview:)];
    button.frame = NSMakeRect(220, 110, 100, 32);
    for (NSView *view in @[input, output, check, button]) [window.contentView addSubview:view];
    [window makeKeyAndOrderFront:nil];
    [app activateIgnoringOtherApps:YES];
    [app run];
  }
  return 0;
}
