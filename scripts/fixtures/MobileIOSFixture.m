#import <UIKit/UIKit.h>

// Offline, disposable fixture for exercising native accessibility through Appium.
@interface FixtureController : UIViewController <UITextFieldDelegate>
@property(nonatomic, strong) UITextField *message;
@property(nonatomic, strong) UISwitch *previewEnabled;
@property(nonatomic, strong) UILabel *preview;
@property(nonatomic, strong) UILabel *details;
@property(nonatomic, strong) UILabel *chosen;
@end

@implementation FixtureController
- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.systemBackgroundColor;
    UIScrollView *scroll = [[UIScrollView alloc] initWithFrame:self.view.bounds];
    scroll.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    scroll.accessibilityLabel = @"Fixture results list";
    scroll.alwaysBounceVertical = YES;
    [self.view addSubview:scroll];
    CGFloat width = self.view.bounds.size.width - 48;
    self.message = [[UITextField alloc] initWithFrame:CGRectMake(24, 24, width, 48)];
    self.message.borderStyle = UITextBorderStyleRoundedRect;
    self.message.accessibilityLabel = @"Message";
    self.message.placeholder = @"Message";
    self.message.autocorrectionType = UITextAutocorrectionTypeNo;
    self.message.autocapitalizationType = UITextAutocapitalizationTypeNone;
    self.message.returnKeyType = UIReturnKeyDone;
    self.message.delegate = self;
    [scroll addSubview:self.message];
    UILabel *switchLabel = [[UILabel alloc] initWithFrame:CGRectMake(24, 88, width - 72, 40)];
    switchLabel.text = @"Enable preview";
    [scroll addSubview:switchLabel];
    self.previewEnabled = [[UISwitch alloc] initWithFrame:CGRectMake(width - 32, 92, 52, 32)];
    self.previewEnabled.accessibilityLabel = @"Enable preview";
    [scroll addSubview:self.previewEnabled];
    UIButton *previewButton = [UIButton buttonWithType:UIButtonTypeSystem];
    previewButton.frame = CGRectMake(24, 144, width, 48);
    [previewButton setTitle:@"Preview" forState:UIControlStateNormal];
    [previewButton addTarget:self action:@selector(showPreview) forControlEvents:UIControlEventTouchUpInside];
    [scroll addSubview:previewButton];
    self.preview = [[UILabel alloc] initWithFrame:CGRectMake(24, 200, width, 48)];
    self.preview.text = @"No preview yet";
    [scroll addSubview:self.preview];
    UIButton *hold = [UIButton buttonWithType:UIButtonTypeSystem];
    hold.frame = CGRectMake(24, 256, width, 48);
    [hold setTitle:@"Hold for details" forState:UIControlStateNormal];
    UILongPressGestureRecognizer *longPress = [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(showDetails:)];
    [hold addGestureRecognizer:longPress];
    [scroll addSubview:hold];
    self.details = [[UILabel alloc] initWithFrame:CGRectMake(24, 312, width, 48)];
    self.details.text = @"Details hidden";
    [scroll addSubview:self.details];
    // Spatial targets: Alpha comes first in the tree but is drawn on the right of Beta.
    CGFloat half = (width - 16) / 2;
    for (NSString *title in @[@"Alpha", @"Beta"]) {
        UIButton *choice = [UIButton buttonWithType:UIButtonTypeSystem];
        choice.frame = CGRectMake([title isEqualToString:@"Alpha"] ? 40 + half : 24, 368, half, 48);
        [choice setTitle:title forState:UIControlStateNormal];
        [choice addTarget:self action:@selector(choose:) forControlEvents:UIControlEventTouchUpInside];
        [scroll addSubview:choice];
    }
    self.chosen = [[UILabel alloc] initWithFrame:CGRectMake(24, 424, width, 48)];
    self.chosen.text = @"Chosen: none";
    [scroll addSubview:self.chosen];
    for (int i = 1; i <= 25; i++) {
        UILabel *row = [[UILabel alloc] initWithFrame:CGRectMake(24, 480 + (i - 1) * 48, width, 48)];
        row.text = [NSString stringWithFormat:@"Fixture row %d", i];
        [scroll addSubview:row];
    }
    scroll.contentSize = CGSizeMake(self.view.bounds.size.width, 480 + 25 * 48);
}
- (void)choose:(UIButton *)sender {
    self.chosen.text = [@"Chosen: " stringByAppendingString:sender.currentTitle];
}
- (BOOL)textFieldShouldReturn:(UITextField *)textField {
    [textField resignFirstResponder];
    return YES;
}
- (void)showPreview {
    self.preview.text = self.previewEnabled.on ? [@"Preview: " stringByAppendingString:self.message.text] : @"Preview disabled";
}
- (void)showDetails:(UILongPressGestureRecognizer *)gesture {
    if (gesture.state == UIGestureRecognizerStateBegan) self.details.text = @"Details are visible";
}
@end

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation FixtureSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    self.window.rootViewController = [FixtureController new];
    [self.window makeKeyAndVisible];
}
@end
@interface FixtureDelegate : UIResponder <UIApplicationDelegate>
@end
@implementation FixtureDelegate
@end
int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(FixtureDelegate.class)); }
}
