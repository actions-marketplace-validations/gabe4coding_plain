#import <Cocoa/Cocoa.h>

@interface PreviewHandler : NSObject
@property NSTextField *input;
@property NSTextField *output;
- (void)preview:(id)sender;
- (void)choose:(NSButton *)sender;
@end
@implementation PreviewHandler
- (void)preview:(id)sender { self.output.stringValue = [@"Preview: " stringByAppendingString:self.input.stringValue]; }
- (void)choose:(NSButton *)sender { self.output.stringValue = [@"Chosen: " stringByAppendingString:sender.title]; }
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
    // Spatial targets: Alpha comes first in the tree but is drawn on the right of Beta.
    NSButton *alpha = [NSButton buttonWithTitle:@"Alpha" target:handler action:@selector(choose:)];
    alpha.frame = NSMakeRect(220, 75, 100, 32);
    NSButton *beta = [NSButton buttonWithTitle:@"Beta" target:handler action:@selector(choose:)];
    beta.frame = NSMakeRect(30, 75, 100, 32);
    for (NSView *view in @[input, output, check, button, alpha, beta]) [window.contentView addSubview:view];
    [window makeKeyAndOrderFront:nil];
    [app activateIgnoringOtherApps:YES];
    [app run];
  }
  return 0;
}
